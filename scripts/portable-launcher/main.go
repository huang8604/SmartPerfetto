// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

package main

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const (
	backendPort  = "3000"
	frontendPort = "10000"
	appName      = "SmartPerfetto"
)

var version = "dev"

type packageLayout struct {
	packageRoot   string
	resources     string
	nodeExe       string
	traceProc     string
	backendRoot   string
	frontendRoot  string
	backendEntry  string
	frontendEntry string
}

type runtimeDirs struct {
	dataDir string
	logsDir string
}

type serviceProcess struct {
	name string
	cmd  *exec.Cmd
	log  *os.File
}

func main() {
	layout, err := resolveLayout()
	if err != nil {
		fatal(err)
	}

	for _, required := range []string{layout.nodeExe, layout.traceProc, layout.backendEntry, layout.frontendEntry} {
		if _, err := os.Stat(required); err != nil {
			fatal(fmt.Errorf("required runtime file is missing: %s", required))
		}
	}

	dirs, err := resolveRuntimeDirs(layout.packageRoot)
	if err != nil {
		fatal(err)
	}
	for _, dir := range []string{
		dirs.dataDir,
		dirs.logsDir,
		filepath.Join(dirs.dataDir, "uploads"),
		filepath.Join(dirs.dataDir, "backend"),
		filepath.Join(dirs.dataDir, "providers"),
		filepath.Join(dirs.dataDir, "user"),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			fatal(err)
		}
	}

	fmt.Printf("%s launcher\n", appName)
	fmt.Printf("Version: %s\n", version)
	fmt.Printf("Package directory: %s\n", layout.packageRoot)
	fmt.Printf("Data directory: %s\n", dirs.dataDir)
	fmt.Printf("Logs directory: %s\n", dirs.logsDir)
	fmt.Printf("Frontend: http://localhost:%s\n", frontendPort)
	fmt.Printf("Backend:  http://localhost:%s\n", backendPort)
	fmt.Println()

	envPath := envFilePath(dirs.dataDir)
	if _, err := os.Stat(envPath); err != nil {
		fmt.Println("No user env file found. The UI can still open, but AI analysis needs a Provider profile or env credentials.")
		fmt.Printf("To use env credentials, create %s and restart %s.\n", envPath, launcherName())
		fmt.Println()
	}

	baseEnv := append([]string{}, os.Environ()...)
	pathEnv := fmt.Sprintf("%s%c%s", nodeBinDir(layout.nodeExe), os.PathListSeparator, os.Getenv("PATH"))
	backendDataDir := filepath.Join(dirs.dataDir, "backend")

	backendEnv := mergeEnv(baseEnv, map[string]string{
		"NODE_ENV":                          "production",
		"PORT":                              backendPort,
		"PATH":                              pathEnv,
		"TRACE_PROCESSOR_PATH":              layout.traceProc,
		"SMARTPERFETTO_PACKAGE":             "1",
		"SMARTPERFETTO_PACKAGE_TARGET_OS":   runtime.GOOS,
		"SMARTPERFETTO_PACKAGE_TARGET_ARCH": runtime.GOARCH,
		"SMARTPERFETTO_OUTPUT_LANGUAGE":     envOrDefault("SMARTPERFETTO_OUTPUT_LANGUAGE", "zh-CN"),
		"SMARTPERFETTO_ENV_FILE":            envPath,
		"SMARTPERFETTO_HOME":                filepath.Join(dirs.dataDir, "user"),
		"SMARTPERFETTO_BACKEND_DATA_DIR":    backendDataDir,
		"SMARTPERFETTO_BACKEND_LOG_DIR":     dirs.logsDir,
		"UPLOAD_DIR":                        filepath.Join(dirs.dataDir, "uploads"),
		"PROVIDER_DATA_DIR_OVERRIDE":        filepath.Join(dirs.dataDir, "providers"),
		"SCENE_REPORT_DIR":                  filepath.Join(backendDataDir, "scene-reports"),
		"TRACE_PROCESSOR_DOWNLOAD_BASE":     os.Getenv("TRACE_PROCESSOR_DOWNLOAD_BASE"),
		"TRACE_PROCESSOR_DOWNLOAD_URL":      os.Getenv("TRACE_PROCESSOR_DOWNLOAD_URL"),
		"SMARTPERFETTO_AGENT_RUNTIME":       os.Getenv("SMARTPERFETTO_AGENT_RUNTIME"),
		"SMARTPERFETTO_API_KEY":             os.Getenv("SMARTPERFETTO_API_KEY"),
	})
	frontendEnv := mergeEnv(baseEnv, map[string]string{
		"PORT": frontendPort,
		"PATH": pathEnv,
	})

	backend, err := startService("backend", layout.nodeExe, []string{layout.backendEntry}, layout.backendRoot, backendEnv, dirs.logsDir)
	if err != nil {
		fatal(err)
	}
	defer backend.closeLog()

	if err := waitForHTTP("http://localhost:"+backendPort+"/health", 90*time.Second); err != nil {
		stopService(backend)
		fatal(fmt.Errorf("backend did not become ready: %w", err))
	}

	frontend, err := startService("frontend", layout.nodeExe, []string{layout.frontendEntry}, layout.frontendRoot, frontendEnv, dirs.logsDir)
	if err != nil {
		stopService(backend)
		fatal(err)
	}
	defer frontend.closeLog()

	if err := waitForHTTP("http://localhost:"+frontendPort+"/", 45*time.Second); err != nil {
		stopService(frontend)
		stopService(backend)
		fatal(fmt.Errorf("frontend did not become ready: %w", err))
	}

	url := "http://localhost:" + frontendPort
	fmt.Println()
	fmt.Println("SmartPerfetto is running.")
	fmt.Printf("Open: %s\n", url)
	fmt.Println("Keep this launcher running while using SmartPerfetto.")
	fmt.Println()
	_ = openBrowser(url)

	exitCh := make(chan string, 2)
	go waitForService(backend, exitCh)
	go waitForService(frontend, exitCh)

	signalCh := make(chan os.Signal, 1)
	signal.Notify(signalCh, os.Interrupt, syscall.SIGTERM)

	select {
	case sig := <-signalCh:
		fmt.Printf("\nReceived %s, stopping SmartPerfetto...\n", sig)
	case name := <-exitCh:
		fmt.Printf("\n%s exited; stopping SmartPerfetto...\n", name)
	}

	stopService(frontend)
	stopService(backend)
	fmt.Println("SmartPerfetto stopped.")
}

func resolveLayout() (packageLayout, error) {
	exe, err := os.Executable()
	if err != nil {
		return packageLayout{}, err
	}
	exeDir, err := filepath.Abs(filepath.Dir(exe))
	if err != nil {
		return packageLayout{}, err
	}

	packageRoot := exeDir
	resources := exeDir
	if runtime.GOOS == "darwin" && filepath.Base(exeDir) == "MacOS" && filepath.Base(filepath.Dir(exeDir)) == "Contents" {
		contentsDir := filepath.Dir(exeDir)
		packageRoot = filepath.Dir(contentsDir)
		resources = filepath.Join(contentsDir, "Resources")
	}

	nodeExe := filepath.Join(resources, "runtime", "node", "bin", "node")
	traceProc := filepath.Join(resources, "bin", "trace_processor_shell")
	if runtime.GOOS == "windows" {
		nodeExe = filepath.Join(resources, "runtime", "node", "node.exe")
		traceProc = filepath.Join(resources, "bin", "trace_processor_shell.exe")
	}

	backendRoot := filepath.Join(resources, "backend")
	frontendRoot := filepath.Join(resources, "frontend")
	return packageLayout{
		packageRoot:   packageRoot,
		resources:     resources,
		nodeExe:       nodeExe,
		traceProc:     traceProc,
		backendRoot:   backendRoot,
		frontendRoot:  frontendRoot,
		backendEntry:  filepath.Join(backendRoot, "dist", "index.js"),
		frontendEntry: filepath.Join(frontendRoot, "server.js"),
	}, nil
}

func resolveRuntimeDirs(packageRoot string) (runtimeDirs, error) {
	if data := os.Getenv("SMARTPERFETTO_PORTABLE_DATA_DIR"); data != "" {
		logs := os.Getenv("SMARTPERFETTO_PORTABLE_LOG_DIR")
		if logs == "" {
			logs = filepath.Join(data, "logs")
		}
		return runtimeDirs{dataDir: data, logsDir: logs}, nil
	}

	home, err := os.UserHomeDir()
	if err != nil && runtime.GOOS != "windows" {
		return runtimeDirs{}, err
	}

	switch runtime.GOOS {
	case "windows":
		return runtimeDirs{
			dataDir: filepath.Join(packageRoot, "data"),
			logsDir: filepath.Join(packageRoot, "logs"),
		}, nil
	case "darwin":
		return runtimeDirs{
			dataDir: filepath.Join(home, "Library", "Application Support", "SmartPerfetto"),
			logsDir: filepath.Join(home, "Library", "Logs", "SmartPerfetto"),
		}, nil
	default:
		dataHome := os.Getenv("XDG_DATA_HOME")
		if dataHome == "" {
			dataHome = filepath.Join(home, ".local", "share")
		}
		stateHome := os.Getenv("XDG_STATE_HOME")
		if stateHome == "" {
			stateHome = filepath.Join(home, ".local", "state")
		}
		return runtimeDirs{
			dataDir: filepath.Join(dataHome, "smartperfetto"),
			logsDir: filepath.Join(stateHome, "smartperfetto", "logs"),
		}, nil
	}
}

func envFilePath(dataDir string) string {
	if value := os.Getenv("SMARTPERFETTO_ENV_FILE"); value != "" {
		return value
	}
	if runtime.GOOS == "windows" {
		return filepath.Join(dataDir, "env")
	}
	return filepath.Join(dataDir, "env")
}

func nodeBinDir(nodeExe string) string {
	return filepath.Dir(nodeExe)
}

func launcherName() string {
	if runtime.GOOS == "windows" {
		return "SmartPerfetto.exe"
	}
	if runtime.GOOS == "darwin" {
		return "SmartPerfetto.app"
	}
	return "SmartPerfetto"
}

func startService(name string, exe string, args []string, dir string, env []string, logsDir string) (*serviceProcess, error) {
	logPath := filepath.Join(logsDir, name+".log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}

	cmd := exec.Command(exe, args...)
	cmd.Dir = dir
	cmd.Env = env
	configureServiceCommand(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = logFile.Close()
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = logFile.Close()
		return nil, err
	}

	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		return nil, err
	}

	writer := io.MultiWriter(os.Stdout, logFile)
	go copyPrefixedOutput(name, stdout, writer)
	go copyPrefixedOutput(name, stderr, writer)

	fmt.Printf("Started %s (PID %d), log: %s\n", name, cmd.Process.Pid, logPath)
	return &serviceProcess{name: name, cmd: cmd, log: logFile}, nil
}

func copyPrefixedOutput(prefix string, reader io.Reader, writer io.Writer) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		fmt.Fprintf(writer, "[%s] %s\n", strings.ToUpper(prefix), scanner.Text())
	}
}

func waitForHTTP(url string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	client := http.Client{Timeout: 2 * time.Second}
	var lastErr error

	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 500 {
				return nil
			}
			lastErr = fmt.Errorf("HTTP %d", resp.StatusCode)
		} else {
			lastErr = err
		}
		time.Sleep(time.Second)
	}

	if lastErr == nil {
		lastErr = fmt.Errorf("timed out")
	}
	return lastErr
}

func waitForService(proc *serviceProcess, exitCh chan<- string) {
	err := proc.cmd.Wait()
	if err != nil {
		exitCh <- fmt.Sprintf("%s (%v)", proc.name, err)
		return
	}
	exitCh <- proc.name
}

func (proc *serviceProcess) closeLog() {
	if proc != nil && proc.log != nil {
		_ = proc.log.Close()
	}
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		return exec.Command("open", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}

func mergeEnv(base []string, overrides map[string]string) []string {
	result := make([]string, 0, len(base)+len(overrides))
	seen := make(map[string]bool, len(overrides))

	for key := range overrides {
		seen[strings.ToUpper(key)] = true
	}

	for _, item := range base {
		key := item
		if idx := strings.IndexByte(item, '='); idx >= 0 {
			key = item[:idx]
		}
		if seen[strings.ToUpper(key)] {
			continue
		}
		result = append(result, item)
	}

	for key, value := range overrides {
		if value == "" {
			continue
		}
		result = append(result, key+"="+value)
	}
	return result
}

func envOrDefault(key string, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func fatal(err error) {
	message := fmt.Sprintf("ERROR: %v", err)
	fmt.Fprintln(os.Stderr, message)
	if runtime.GOOS == "darwin" {
		_ = exec.Command("osascript", "-e", fmt.Sprintf(`display alert "SmartPerfetto failed" message %q`, message)).Run()
	} else if runtime.GOOS == "windows" {
		fmt.Fprintln(os.Stderr, "Press Enter to exit.")
		_, _ = fmt.Fscanln(os.Stdin)
	}
	os.Exit(1)
}

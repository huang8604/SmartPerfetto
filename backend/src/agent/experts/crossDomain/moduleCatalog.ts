// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Module Catalog
 *
 * Provides a registry of available module experts and their capabilities.
 * Helps cross-domain experts discover and route to appropriate modules.
 *
 * The catalog can be populated from:
 * 1. Skill registry (auto-discover skills with module metadata)
 * 2. Static configuration (predefined module mappings)
 */

import {
  ModuleCatalogEntry,
  ModuleCapability,
} from './types';
import { ModuleLayer } from '../../../services/skillEngine/types';
import { skillRegistry, ensureSkillRegistryInitialized } from '../../../services/skillEngine/skillLoader';

/**
 * Static module-to-skill mapping for common analysis scenarios
 * This provides a fallback when skills don't have explicit module metadata.
 *
 * Each module maps to:
 * - Its dedicated module skill file (e.g., scheduler_module)
 * - Related composite skills for detailed analysis
 */
const STATIC_MODULE_MAPPINGS: Record<string, {
  layer: ModuleLayer;
  component: string;
  skills: string[];
  relatedModules: string[];
}> = {
  // ==========================================================================
  // Kernel layer
  // ==========================================================================
  'kernel_scheduler': {
    layer: 'kernel',
    component: 'Scheduler',
    skills: ['scheduler_module', 'cpu_analysis', 'scheduling_analysis'],
    relatedModules: ['hardware_cpu', 'framework_ams'],
  },
  'kernel_binder': {
    layer: 'kernel',
    component: 'Binder',
    skills: ['binder_module', 'binder_analysis', 'binder_detail'],
    relatedModules: ['framework_ams', 'framework_wms'],
  },
  'kernel_filesystem': {
    layer: 'kernel',
    component: 'FileSystem',
    skills: ['filesystem_module', 'io_analysis'],
    relatedModules: ['framework_ams', 'hardware_memory'],
  },
  'kernel_lockcontention': {
    layer: 'kernel',
    component: 'LockContention',
    skills: ['lock_contention_module'],
    relatedModules: ['kernel_scheduler', 'framework_art', 'app_third_party'],
  },

  // ==========================================================================
  // Framework layer
  // ==========================================================================
  'framework_surfaceflinger': {
    layer: 'framework',
    component: 'SurfaceFlinger',
    skills: ['surfaceflinger_module', 'scrolling_analysis', 'jank_frame_detail'],
    relatedModules: ['hardware_gpu', 'framework_wms', 'framework_choreographer', 'app_third_party'],
  },
  'framework_ams': {
    layer: 'framework',
    component: 'AMS',
    skills: ['ams_module', 'startup_analysis', 'startup_detail', 'anr_analysis'],
    relatedModules: ['kernel_scheduler', 'kernel_binder', 'kernel_filesystem'],
  },
  'framework_wms': {
    layer: 'framework',
    component: 'WMS',
    skills: ['wms_module', 'click_response_analysis', 'click_response_detail'],
    relatedModules: ['framework_input', 'framework_surfaceflinger', 'framework_choreographer'],
  },
  'framework_input': {
    layer: 'framework',
    component: 'Input',
    skills: ['input_module', 'click_response_analysis'],
    relatedModules: ['framework_wms', 'app_third_party'],
  },
  'framework_art': {
    layer: 'framework',
    component: 'ART',
    skills: ['art_module', 'memory_analysis'],
    relatedModules: ['kernel_scheduler', 'hardware_memory', 'kernel_lockcontention'],
  },
  'framework_choreographer': {
    layer: 'framework',
    component: 'Choreographer',
    skills: ['choreographer_module'],
    relatedModules: ['framework_surfaceflinger', 'hardware_gpu', 'app_third_party'],
  },

  // ==========================================================================
  // Hardware layer
  // ==========================================================================
  'hardware_cpu': {
    layer: 'hardware',
    component: 'CPU',
    skills: ['cpu_module', 'cpu_analysis'],
    relatedModules: ['kernel_scheduler', 'hardware_thermal', 'hardware_power'],
  },
  'hardware_gpu': {
    layer: 'hardware',
    component: 'GPU',
    skills: ['gpu_module', 'scrolling_analysis'],
    relatedModules: ['framework_surfaceflinger', 'hardware_thermal'],
  },
  'hardware_memory': {
    layer: 'hardware',
    component: 'Memory',
    skills: ['memory_module', 'memory_analysis'],
    relatedModules: ['framework_art', 'kernel_filesystem'],
  },
  'hardware_thermal': {
    layer: 'hardware',
    component: 'Thermal',
    skills: ['thermal_module'],
    relatedModules: ['hardware_cpu', 'hardware_gpu', 'kernel_scheduler'],
  },
  'hardware_power': {
    layer: 'hardware',
    component: 'Power',
    skills: ['power_module'],
    relatedModules: ['hardware_cpu', 'kernel_scheduler', 'framework_ams'],
  },

  // ==========================================================================
  // App layer
  // ==========================================================================
  'app_third_party': {
    layer: 'app',
    component: 'ThirdParty',
    skills: ['third_party_module', 'scrolling_analysis', 'startup_analysis', 'click_response_analysis'],
    relatedModules: ['framework_surfaceflinger', 'framework_ams', 'kernel_scheduler'],
  },
  'app_launcher': {
    layer: 'app',
    component: 'Launcher',
    skills: ['launcher_module'],
    relatedModules: ['framework_ams', 'framework_wms', 'app_systemui'],
  },
  'app_systemui': {
    layer: 'app',
    component: 'SystemUI',
    skills: ['systemui_module'],
    relatedModules: ['framework_wms', 'framework_input', 'app_launcher'],
  },
};

/**
 * ModuleCatalog - Registry of module experts
 */
export class ModuleCatalog {
  private modules: Map<string, ModuleCatalogEntry> = new Map();
  private skillToModule: Map<string, string> = new Map();
  private initialized = false;

  constructor() {
    // Auto-initialize on first use
  }

  /**
   * Initialize catalog from skill registry and static mappings
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // CRITICAL: Ensure skill registry is initialized before accessing it
    await ensureSkillRegistryInitialized();

    // First, add static mappings
    for (const [moduleId, mapping] of Object.entries(STATIC_MODULE_MAPPINGS)) {
      this.addModule({
        name: moduleId,
        displayName: `${mapping.component} (${mapping.layer})`,
        layer: mapping.layer,
        component: mapping.component,
        subsystems: [],
        capabilities: [],
        relatedModules: mapping.relatedModules,
      });

      // Map skills to module
      for (const skillName of mapping.skills) {
        this.skillToModule.set(skillName, moduleId);
      }
    }

    // Then, discover modules from skill registry
    try {
      const moduleSkills = skillRegistry.getAllModuleSkills();

      for (const skill of moduleSkills) {
        if (!skill.module) continue;

        const moduleId = `${skill.module.layer}_${skill.module.component.toLowerCase()}`;

        // Create or update module entry
        let entry = this.modules.get(moduleId);
        if (!entry) {
          entry = {
            name: moduleId,
            displayName: `${skill.module.component} (${skill.module.layer})`,
            layer: skill.module.layer,
            component: skill.module.component,
            subsystems: skill.module.subsystems || [],
            capabilities: [],
            relatedModules: skill.module.relatedModules || [],
          };
          this.modules.set(moduleId, entry);
        }

        // Add capabilities from dialogue interface
        if (skill.dialogue?.capabilities) {
          for (const cap of skill.dialogue.capabilities) {
            // Avoid duplicates
            if (!entry.capabilities.some(c => c.id === cap.id)) {
              entry.capabilities.push({
                id: cap.id,
                questionTemplate: cap.questionTemplate,
                requiredParams: cap.requiredParams,
                optionalParams: cap.optionalParams || [],
                description: cap.description || '',
              });
            }
          }
        }

        // Map skill to module
        this.skillToModule.set(skill.name, moduleId);
      }
    } catch (e) {
      console.warn('[ModuleCatalog] Failed to discover module skills:', e);
    }

    this.initialized = true;
    console.log(`[ModuleCatalog] Initialized with ${this.modules.size} modules`);
  }

  /**
   * Ensure catalog is initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      // Synchronous fallback - just use static mappings
      for (const [moduleId, mapping] of Object.entries(STATIC_MODULE_MAPPINGS)) {
        if (!this.modules.has(moduleId)) {
          this.addModule({
            name: moduleId,
            displayName: `${mapping.component} (${mapping.layer})`,
            layer: mapping.layer,
            component: mapping.component,
            subsystems: [],
            capabilities: [],
            relatedModules: mapping.relatedModules,
          });

          for (const skillName of mapping.skills) {
            this.skillToModule.set(skillName, moduleId);
          }
        }
      }
      this.initialized = true;
    }
  }

  // ===========================================================================
  // Module Access
  // ===========================================================================

  /**
   * Add a module to the catalog
   */
  addModule(entry: ModuleCatalogEntry): void {
    this.modules.set(entry.name, entry);
  }

  /**
   * Get a module by name
   */
  getModule(name: string): ModuleCatalogEntry | undefined {
    this.ensureInitialized();
    return this.modules.get(name);
  }

  /**
   * Check if a module exists
   */
  hasModule(name: string): boolean {
    this.ensureInitialized();
    return this.modules.has(name);
  }

  /**
   * Get all modules
   */
  getAllModules(): ModuleCatalogEntry[] {
    this.ensureInitialized();
    return Array.from(this.modules.values());
  }

  /**
   * Get modules by layer
   */
  getModulesByLayer(layer: ModuleLayer): ModuleCatalogEntry[] {
    this.ensureInitialized();
    return this.getAllModules().filter(m => m.layer === layer);
  }

  /**
   * Get module by component name
   */
  getModuleByComponent(component: string): ModuleCatalogEntry | undefined {
    this.ensureInitialized();
    const normalized = component.toLowerCase();
    return this.getAllModules().find(
      m => m.component.toLowerCase() === normalized
    );
  }

  // ===========================================================================
  // Skill Mapping
  // ===========================================================================

  /**
   * Get the module that owns a skill
   */
  getModuleForSkill(skillName: string): string | undefined {
    this.ensureInitialized();
    return this.skillToModule.get(skillName);
  }

  /**
   * Get skills for a module
   */
  getSkillsForModule(moduleId: string): string[] {
    this.ensureInitialized();
    const skills: string[] = [];
    for (const [skill, module] of this.skillToModule.entries()) {
      if (module === moduleId) {
        skills.push(skill);
      }
    }
    return skills;
  }

  /**
   * Map a skill to a module
   */
  mapSkillToModule(skillName: string, moduleId: string): void {
    this.skillToModule.set(skillName, moduleId);
  }

  // ===========================================================================
  // Related Modules
  // ===========================================================================

  /**
   * Get related modules for a given module
   */
  getRelatedModules(moduleId: string): string[] {
    this.ensureInitialized();
    const module = this.modules.get(moduleId);
    return module?.relatedModules || [];
  }

  /**
   * Find modules that can help with a specific analysis type
   */
  findModulesForAnalysis(analysisType: string): string[] {
    this.ensureInitialized();

    const typeToModules: Record<string, string[]> = {
      // Rendering/UI performance
      'scrolling': ['framework_surfaceflinger', 'framework_choreographer', 'hardware_gpu', 'app_third_party'],
      'jank': ['framework_surfaceflinger', 'framework_choreographer', 'kernel_scheduler', 'hardware_cpu'],
      'frame': ['framework_choreographer', 'framework_surfaceflinger', 'hardware_gpu'],
      // Startup/launch
      'startup': ['framework_ams', 'kernel_binder', 'kernel_filesystem', 'app_third_party'],
      'launch': ['framework_ams', 'app_launcher', 'kernel_binder', 'framework_wms'],
      // Input/interaction
      'click': ['framework_wms', 'framework_input', 'kernel_binder'],
      'touch': ['framework_input', 'framework_wms', 'app_third_party'],
      // System stability
      'anr': ['framework_ams', 'kernel_binder', 'kernel_scheduler', 'kernel_lockcontention'],
      'lock': ['kernel_lockcontention', 'kernel_scheduler', 'framework_art'],
      'deadlock': ['kernel_lockcontention', 'kernel_scheduler'],
      // Memory
      'memory': ['hardware_memory', 'framework_art', 'kernel_filesystem'],
      'lmk': ['hardware_memory', 'framework_ams'],
      'gc': ['framework_art', 'hardware_memory'],
      // CPU/scheduling
      'cpu': ['kernel_scheduler', 'hardware_cpu', 'hardware_thermal'],
      'scheduler': ['kernel_scheduler', 'hardware_cpu'],
      // I/O
      'io': ['kernel_filesystem', 'hardware_memory'],
      'file': ['kernel_filesystem'],
      // IPC
      'binder': ['kernel_binder', 'framework_ams'],
      // Thermal/power
      'thermal': ['hardware_thermal', 'hardware_cpu', 'hardware_gpu'],
      'power': ['hardware_power', 'hardware_cpu', 'kernel_scheduler'],
      'battery': ['hardware_power', 'hardware_thermal'],
      'wakelock': ['hardware_power', 'framework_ams'],
      // System UI
      'statusbar': ['app_systemui', 'framework_wms'],
      'notification': ['app_systemui', 'framework_wms'],
      'systemui': ['app_systemui', 'framework_wms', 'framework_input'],
      'launcher': ['app_launcher', 'framework_ams', 'framework_wms'],
    };

    const normalizedType = analysisType.toLowerCase();
    for (const [key, modules] of Object.entries(typeToModules)) {
      if (normalizedType.includes(key)) {
        return modules;
      }
    }

    return [];
  }

  // ===========================================================================
  // Capability Queries
  // ===========================================================================

  /**
   * Find modules that can answer a specific question type
   */
  findModulesByCapability(capabilityId: string): string[] {
    this.ensureInitialized();
    const result: string[] = [];

    for (const [moduleId, entry] of this.modules.entries()) {
      if (entry.capabilities.some(c => c.id === capabilityId)) {
        result.push(moduleId);
      }
    }

    return result;
  }

  /**
   * Get all available capabilities across all modules
   */
  getAllCapabilities(): Array<{ moduleId: string; capability: ModuleCapability }> {
    this.ensureInitialized();
    const result: Array<{ moduleId: string; capability: ModuleCapability }> = [];

    for (const [moduleId, entry] of this.modules.entries()) {
      for (const capability of entry.capabilities) {
        result.push({ moduleId, capability });
      }
    }

    return result;
  }

  // ===========================================================================
  // Utility
  // ===========================================================================

  /**
   * Get module hierarchy path (layer -> component -> subsystems)
   */
  getModulePath(moduleId: string): string {
    const module = this.modules.get(moduleId);
    if (!module) return moduleId;

    const parts = [module.layer, module.component];
    if (module.subsystems.length > 0) {
      parts.push(module.subsystems.join('/'));
    }
    return parts.join(' > ');
  }

  /**
   * Print catalog summary for debugging
   */
  printSummary(): void {
    this.ensureInitialized();
    console.log('\n=== Module Catalog Summary ===');

    const byLayer: Record<string, ModuleCatalogEntry[]> = {};
    for (const entry of this.modules.values()) {
      if (!byLayer[entry.layer]) {
        byLayer[entry.layer] = [];
      }
      byLayer[entry.layer].push(entry);
    }

    for (const layer of ['app', 'framework', 'kernel', 'hardware'] as ModuleLayer[]) {
      const modules = byLayer[layer] || [];
      console.log(`\n[${layer.toUpperCase()}] (${modules.length} modules)`);
      for (const m of modules) {
        const skills = this.getSkillsForModule(m.name);
        console.log(`  - ${m.name}: ${skills.length} skills, ${m.capabilities.length} capabilities`);
      }
    }
    console.log('');
  }
}

/**
 * Singleton instance for global access
 */
export const moduleCatalog = new ModuleCatalog();
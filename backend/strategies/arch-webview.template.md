<!-- No template variables — static content -->
### WebView 分析注意事项
- **渲染线程**：WebView 有独立的 Compositor 线程和 Renderer 线程，不在标准 RenderThread 中
- **Surface 类型**：GLFunctor (传统) vs SurfaceControl (现代)，后者性能更好
- **JS 执行**：观察 V8 相关 slice（`v8.run`, `v8.compile`）来定位 JS 瓶颈
- **帧渲染**：WebView 帧不走 Choreographer 路径，需通过 SurfaceFlinger 消费端判断掉帧

# SmartPerfetto 当前 Strategy / Skill 清单

这份清单由当前仓库扫描得到，用于外部交流时补充 PPT 中的“秀肌肉”页。PPT 负责展示版图，这里保留完整名单。

## Strategy

- Strategy 文件数：21
- normal scene：19
- contract-only：2

| 文件 | scene | priority | effort | 类型 |
|---|---|---:|---|---|
| `anr.strategy.md` | `anr` | 1 | medium | normal |
| `game.strategy.md` | `game` | 4 | medium | normal |
| `general.strategy.md` | `general` | 99 | high | normal |
| `interaction.strategy.md` | `interaction` | 4 | medium | normal |
| `io.strategy.md` | `io` | 5 | medium | normal |
| `linux.strategy.md` | `linux` | 7 | medium | normal |
| `media.strategy.md` | `media` | 6 | medium | normal |
| `memory.strategy.md` | `memory` | 4 | medium | normal |
| `multi-trace-result-comparison.strategy.md` | `multi_trace_result_comparison` | 0 | medium | normal |
| `network.strategy.md` | `network` | 6 | medium | normal |
| `overview.strategy.md` | `overview` | 5 | high | normal |
| `pipeline.strategy.md` | `pipeline` | 4 | medium | normal |
| `power.strategy.md` | `power` | 4 | medium | normal |
| `runtime-correctness.strategy.md` | `runtime_correctness` | 5 | medium | normal |
| `scroll-response.strategy.md` | `scroll_response` | 3 | medium | normal |
| `scrolling.strategy.md` | `scrolling` | 3 | medium | normal |
| `smart.strategy.md` | `smart` | 5 | high | contract-only |
| `startup.strategy.md` | `startup` | 2 | medium | normal |
| `teaching.strategy.md` | `teaching` | 3 | medium | normal |
| `touch-tracking.strategy.md` | `touch_tracking` | 3 | medium | normal |
| `verifier-misdiagnosis.strategy.md` | `verifier_misdiagnosis` | 99 | low | contract-only |

## Skill 分布

- `.skill.yaml` 总数：231

| 目录 | 数量 |
|---|---:|
| `_template` | 4 |
| `atomic` | 136 |
| `comparison` | 1 |
| `composite` | 38 |
| `deep` | 2 |
| `modules` | 18 |
| `pipelines` | 32 |

## `_template`

1. `atomic_A_template`
2. `atomic_B_template`
3. `atomic_S_template`
4. `composite_S_template`

## `atomic`

1. `android_bitmap_memory_per_process`
2. `android_dvfs_counter_stats`
3. `android_gpu_work_period_track`
4. `android_heap_graph_leak_candidates`
5. `android_heap_graph_summary`
6. `android_job_scheduler_events`
7. `android_kernel_wakelock_summary`
8. `anr_context_in_range`
9. `anr_main_thread_blocking`
10. `app_frame_production`
11. `app_lifecycle_in_range`
12. `app_process_starts_summary`
13. `battery_charge_timeline`
14. `battery_doze_state_timeline`
15. `battery_drain_rate_summary`
16. `binder_blocking_in_range`
17. `binder_in_range`
18. `binder_root_cause`
19. `binder_storm_detection`
20. `blocking_chain_analysis`
21. `buffer_transaction_lifecycle`
22. `cache_miss_impact`
23. `chrome_scroll_jank_frame_timeline`
24. `compose_recomposition_hotspot`
25. `consumer_jank_detection`
26. `cpu_cluster_load_in_range`
27. `cpu_cluster_mapping_view`
28. `cpu_freq_residency_summary`
29. `cpu_freq_timeline`
30. `cpu_idle_analysis`
31. `cpu_idle_state_residency`
32. `cpu_load_in_range`
33. `cpu_process_utilization_period`
34. `cpu_slice_analysis`
35. `cpu_thread_utilization_period`
36. `cpu_throttling_in_range`
37. `cpu_time_per_frame`
38. `cpu_topology_detection`
39. `cpu_topology_view`
40. `cpu_utilization_per_period`
41. `device_state_timeline`
42. `fence_wait_decomposition`
43. `fpsgo_analysis`
44. `frame_blocking_calls`
45. `frame_overrun_summary`
46. `frame_pipeline_variance`
47. `frame_production_gap`
48. `frame_ui_time_breakdown`
49. `futex_wait_distribution`
50. `game_fps_analysis`
51. `game_main_loop_jank`
52. `gc_events_in_range`
53. `gl_standalone_swap_jank`
54. `gpu_freq_in_range`
55. `gpu_frequency_analysis`
56. `gpu_metrics`
57. `gpu_power_state_analysis`
58. `gpu_render_in_range`
59. `input_events_in_range`
60. `input_to_frame_latency`
61. `linux_irq_summary`
62. `linux_perf_counter_hotspots`
63. `linux_process_rss_swap_timeline`
64. `linux_runqueue_depth_timeline`
65. `linux_sched_latency_distribution`
66. `lmk_kill_attribution`
67. `lock_contention_in_range`
68. `logcat_analysis`
69. `main_thread_file_io_in_range`
70. `main_thread_sched_latency_in_range`
71. `main_thread_slices_in_range`
72. `main_thread_states_in_range`
73. `mali_gpu_power_state`
74. `media_codec_activity`
75. `memory_growth_detector`
76. `memory_pressure_in_range`
77. `memory_rss_high_watermark`
78. `modem_network_correlation_summary`
79. `native_heap_breakdown`
80. `oom_adjuster_score_timeline`
81. `page_fault_in_range`
82. `pipeline_4feature_scoring`
83. `pipeline_key_slices_overlay`
84. `power_rails_energy_breakdown`
85. `present_fence_timing`
86. `process_identity_resolver`
87. `process_slice_cpu_hotspots`
88. `render_pipeline_latency`
89. `render_thread_slices`
90. `rendering_pipeline_detection`
91. `rn_bridge_to_frame_jank`
92. `rn_fabric_render_jank`
93. `sched_latency_in_range`
94. `scheduling_analysis`
95. `screen_off_background_cpu_attribution`
96. `scroll_response_latency`
97. `sf_composition_in_range`
98. `sf_frame_consumption`
99. `sf_layer_count_in_range`
100. `startup_binder_in_range`
101. `startup_binder_pool_analysis`
102. `startup_breakdown_in_range`
103. `startup_class_loading_in_range`
104. `startup_cpu_placement_timeline`
105. `startup_critical_tasks`
106. `startup_events_in_range`
107. `startup_freq_rampup`
108. `startup_gc_in_range`
109. `startup_hot_slice_states`
110. `startup_jit_analysis`
111. `startup_main_thread_binder_blocking_in_range`
112. `startup_main_thread_file_io_in_range`
113. `startup_main_thread_slices_in_range`
114. `startup_main_thread_states_in_range`
115. `startup_main_thread_sync_binder_in_range`
116. `startup_sched_latency_in_range`
117. `startup_slow_reasons`
118. `startup_thread_blocking_graph`
119. `system_load_in_range`
120. `task_migration_in_range`
121. `textureview_producer_frame_timing`
122. `thermal_predictor`
123. `thread_affinity_violation`
124. `touch_to_display_latency`
125. `util_tracking_analysis`
126. `vrr_detection`
127. `vsync_alignment_in_range`
128. `vsync_config`
129. `vsync_period_detection`
130. `vsync_phase_alignment`
131. `wakelock_tracking`
132. `wakeup_frequency_summary`
133. `wattson_app_startup_power`
134. `wattson_rails_power_breakdown`
135. `wattson_thread_power_attribution`
136. `webview_v8_analysis`

## `comparison`

1. `multi_trace_result_comparison`

## `composite`

1. `anr_analysis`
2. `anr_detail`
3. `battery_drain_attribution`
4. `binder_analysis`
5. `binder_detail`
6. `block_io_analysis`
7. `click_response_analysis`
8. `click_response_detail`
9. `code_pinpoint`
10. `cpu_analysis`
11. `device_state_snapshot`
12. `dmabuf_analysis`
13. `flutter_scrolling_analysis`
14. `gc_analysis`
15. `global_trace_sanity_check`
16. `gpu_analysis`
17. `io_pressure`
18. `irq_analysis`
19. `jank_frame_detail`
20. `lmk_analysis`
21. `lock_binder_wait`
22. `lock_contention_analysis`
23. `memory_analysis`
24. `navigation_analysis`
25. `network_analysis`
26. `power_consumption_overview`
27. `scene_reconstruction`
28. `scroll_session_analysis`
29. `scrolling_analysis`
30. `selection_range_cpu_sched_summary`
31. `startup_analysis`
32. `startup_detail`
33. `state_timeline`
34. `surfaceflinger_analysis`
35. `suspend_wakeup_analysis`
36. `thermal_throttling`
37. `thermal_throttling_chain`
38. `webview_drawfunctor_jank_chain`

## `deep`

1. `callstack_analysis`
2. `cpu_profiling`

## `modules`

1. `launcher_module`
2. `systemui_module`
3. `third_party_module`
4. `ams_module`
5. `art_module`
6. `choreographer_module`
7. `input_module`
8. `surfaceflinger_module`
9. `wms_module`
10. `cpu_module`
11. `gpu_module`
12. `memory_module`
13. `power_module`
14. `thermal_module`
15. `binder_module`
16. `filesystem_module`
17. `lock_contention_module`
18. `scheduler_module`

## `pipelines`

1. `_base`
2. `android_pip_freeform`
3. `android_view_mixed`
4. `android_view_multi_window`
5. `android_view_software`
6. `android_view_standard_blast`
7. `android_view_standard_legacy`
8. `angle_gles_vulkan`
9. `camera_pipeline`
10. `chrome_browser_viz`
11. `compose_standard`
12. `flutter_surfaceview_impeller`
13. `flutter_surfaceview_skia`
14. `flutter_textureview`
15. `game_engine`
16. `hardware_buffer_renderer`
17. `imagereader_pipeline`
18. `opengl_es`
19. `rn_new_arch`
20. `rn_old_arch`
21. `rn_skia`
22. `software_compositing`
23. `surface_control_api`
24. `surfaceview_blast`
25. `textureview_standard`
26. `variable_refresh_rate`
27. `video_overlay_hwc`
28. `vulkan_native`
29. `webview_gl_functor`
30. `webview_surface_control`
31. `webview_surfaceview_wrapper`
32. `webview_textureview_custom`

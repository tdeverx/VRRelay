# Compatibility policy

The default VOD profile is H.264 8-bit `yuv420p`, AAC-LC stereo at 48 kHz, at most 30 fps, delivered as MPEG-TS HLS. Live uses H.264/AAC HLS. These are candidates until a real VRChat build records evidence.

H.265, AV1, fMP4 HLS, fragmented MP4, low-latency HLS, RTSP, HTTP MPEG-TS, passthrough, and subtitle burn-in are experiments. The dashboard keeps unavailable presets visible with their missing capability and records startup, duration, pause, seeking, late join, completion, audio, video, platform, and player.

Acceptance requires a VOD and live profile to pass the chosen PC reference player. Quest support must not be marked verified without a real-device HTTPS test.

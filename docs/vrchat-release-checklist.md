# VRChat release evidence

Record app/build, world, player, platform, headset, network, trusted HTTPS host, profile name, media fingerprint, tester count, date, and tester. Attach the compatibility record and redacted logs.

| Check                                  | PC AVPro | PC Unity/direct | Quest AVPro | Quest Unity/direct | VideoTXL | ProTV |
| -------------------------------------- | -------- | --------------- | ----------- | ------------------ | -------- | ----- |
| VOD starts and reports finite duration |          |                 |             |                    |          |       |
| Pause/resume and forward/back seek     |          |                 |             |                    |          |       |
| Late join and synchronization          |          |                 |             |                    |          |       |
| Completion, replay, reconnect          |          |                 |             |                    |          |       |
| Correct audio/video                    |          |                 |             |                    |          |       |
| OBS live starts and reconnects         |          |                 |             |                    |          |       |
| HTTPS URL permission/allowlist         |          |                 |             |                    |          |       |

Release requires reliable PC results with the production H.264/yuv420p/AAC MPEG-TS HLS VOD preset and default OBS HLS preset. Record Quest results, but do not claim Quest support until trusted-HTTPS tests pass on a real device.

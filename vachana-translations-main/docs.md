ffmpeg -f avfoundation -i ":0" \
  -ac 1 -ar 48000 \
  -c:a opus -b:a 64k \
  -f mpegts \
  "srt://172.16.9.11:9999?mode=caller&latency=200000"



ffmpeg -f avfoundation -i ":" \
  -ac 1 -ar 48000 \
  -c:a libopus -b:a 48k \
  -f mpegts \
  "srt://172.16.9.11:9999:9000?mode=caller&latency=120000"




ffmpeg -f avfoundation -i ":1" \
  -ac 1 -ar 8000 \
  -c:a pcm_s16le \
  -f mpegts \
  "srt://localhost:8111?mode=caller&latency=120000"

Working:

Sender:

ffmpeg -f avfoundation -i ":2" \
-ac 1 -ar 48000 \
-c:a libopus -b:a 48k \
-f mpegts \
"srt://172.16.9.11:9999:9000?mode=caller&latency=120000"


ffmpeg -f avfoundation -i ":2" \
  -ac 1 -ar 48000 \
  -c:a libopus -b:a 48k \
  -f mpegts \
  "srt://localhost:9000?mode=caller&latency=120000"


ffmpeg -f avfoundation -i ":2" \
  -ac 1 -ar 48000 \
  -c:a libopus -b:a 48k \
  -f mpegts \
  "srt://localhost:9000?mode=caller&latency=120000&linger=1&timeout=5000000"

WO:
ffmpeg -f avfoundation -i ":2" \
  -ac 1 -ar 8000 \
  -c:a libopus -b:a 16k \
  -f mpegts \
  "srt://localhost:9000?mode=caller&latency=120000"

Working:
ffmpeg -f avfoundation -i ":2" -ac 1 -ar 8000 -c:a pcm_s16le -f s16le "srt://localhost:9000?mode=caller&latency=120000"


Receiver:
ffmpeg -i "srt://:9000?mode=listener" \
  -map 0:a:0 \
  -c:a pcm_s16le \
  -ar 48000 -ac 1 \
  output.wav


ffmpeg -i "srt://0.0.0.0:9000?mode=listener" \
  -c:a pcm_s16le -ar 48000 -ac 1 \
  output.wav



ffmpeg -f avfoundation -i ":2" \
-ac 1 -ar 48000 \
-c:a libopus -b:a 48k \
-f mpegts \
"srt://localhost:9999:9000?mode=caller&latency=120000"


----------------
----------------
----------------


ffmpeg -f avfoundation -i ":1" \
  -ac 1 -ar 48000 \
  -c:a libopus -b:a 32k \
  -f mpegts \
  "srt://172.16.9.9:8111?mode=caller&latency=120000"


<!-- USE API to get the SRT URL, and then use this: -->

ffmpeg -re -i "https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1772297305/ei/-ceiaZaLK9GPssUP94mGgAc/ip/49.37.179.120/id/hm4gDjY4bPs.1/itag/91/source/yt_live_broadcast/requiressl/yes/ratebypass/yes/live/1/sgoap/gir%3Dyes%3Bitag%3D139/sgovp/gir%3Dyes%3Bitag%3D160/rqh/1/hls_chunk_host/rr3---sn-gwpa-cagk.googlevideo.com/xpc/EgVo2aDSNQ%3D%3D/playlist_duration/30/manifest_duration/30/bui/AVNa5-w5FkCHPQoscHDFIXluWTIaomhdbO6JH1rqw7NE3chI1N49mOFp9EFAF8ZGjCErQOkf6Z0M-iNq/spc/6dlaFNZDk2KCM6mnzrJz3hcytTZQ_Dm0a8WpqhJVqnflZoknJDrnHkFoqFRrEA/vprv/1/reg/0/playlist_type/DVR/initcwndbps/805000/met/1772275706,/mh/PE/mm/44/mn/sn-gwpa-cagk/ms/lva/mv/m/mvi/3/pl/20/rms/lva,lva/dover/11/pacing/0/keepalive/yes/fexp/51552689,51565116,51565681,51580968,51791333/mt/1772275239/sparams/expire,ei,ip,id,itag,source,requiressl,ratebypass,live,sgoap,sgovp,rqh,xpc,playlist_duration,manifest_duration,bui,spc,vprv,reg,playlist_type/sig/AHEqNM4wRgIhAOf2_VP5tK0sbfeLTJptrCa9y5as1g3ILgd0hr-lO0YBAiEA423AmSMBosVLzlOEbUwbNe1yesbhp3QD9mTcmzcCADU%3D/lsparams/hls_chunk_host,initcwndbps,met,mh,mm,mn,ms,mv,mvi,pl,rms/lsig/APaTxxMwRgIhAPMch6cEAwkId86TvGLQcKmUFcOliFlhML0cqA_64bOUAiEA-C-fNCEQBuWQbBhZGQhaEoUdlZ6imxPPIxYZcUKB4Xc%3D/playlist/index.m3u8" \
  -vn \
  -ac 1 -ar 16000 \
  -c:a libopus -b:a 32k \
  -f mpegts \
  "srt://172.16.9.9:8111?mode=caller&latency=120000"

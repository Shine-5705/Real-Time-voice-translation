docker build -t yt-live-translation-server .
docker stop yt-live-translation-server
docker rm yt-live-translation-server
docker run -d -p 8112:8112 -p 8111:8111/udp --name yt-live-translation-server yt-live-translation-server
docker logs -f yt-live-translation-server
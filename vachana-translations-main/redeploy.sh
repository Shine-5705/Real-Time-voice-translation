docker build -t yt-live-translation-server .
docker stop yt-live-translation-server
docker rm yt-live-translation-server
docker run -d --net=host  -v /home/ubuntu/adityar/files:/app/files --name yt-live-translation-server yt-live-translation-server
docker logs -f yt-live-translation-server
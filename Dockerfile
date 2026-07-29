from node:20-alpine as builder

workdir /home/circletron/app
copy package.json package-lock.json ./
run npm install
copy src ./src
run npm run build

from node:20-alpine
run apk add git openssh-client && npm install -g lerna@8.2.4
copy --from=builder /home/circletron/app /home/circletron/app
run \
  ln -s /home/circletron/app /usr/local/lib/node_modules/circletron && \
  ln -s /home/circletron/app/dist/index.js /usr/local/bin/circletron && \
  chmod a+x /usr/local/bin/circletron

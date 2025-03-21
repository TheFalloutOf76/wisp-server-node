# wisp-server-node

A [wisp protocol](https://github.com/MercuryWorkshop/wisp-protocol) server implementation, written in NodeJS.

This fork allows you to use a socks5 proxy (eg Cloudflare WARP, TOR, etc), and use blacklists (ads, malware, etc)

### Usage ✨

You can integrate it into your existing node:http server pretty easily by just adding this to your code

```js
httpServer.on("upgrade", (req, socket, head) => {
    wisp.routeRequest(req, socket, head, {
        proxy: {
            host: '127.0.0.1',
            port: 9050
        },
        blacklist: {
            domains: [
                "pagead2.googlesyndication.com",
                "static.cloudflareinsights.com"
            ],
            ips: [
                ""
            ]
        }
    });
});
```

### Migrating while dual wielding bare-server-node 🤺

If you're migrating from bare server but want to retain both, simply use

```js
httpServer.on("upgrade", (req, socket, head) => {
    if (bare.shouldRoute(req)) {
        bare.routeUpgrade(req, socket, head);
    } else {
        wisp.routeRequest(req, socket, head);
    }
});
```

wisp-server-node doesn't need to handle regular requests, just upgrade events.

### Is it fast? 🚀

It's good enough for testing, it's easy to integrate into your existing app, and maybe it's good enough for light prod usage, but chances are if you're at the scale where you're running a reverse proxy, you should use [epoxy-server](https://github.com/MercuryWorkshop/epoxy-tls) which will deliver better performance at a lower memory footprint

### Is it API stable? 🐎

I don't personally plan on breaking api compatibility, so unless a serial killer is holding my family at gun point under the condition of breaking wisp-server-node's API, probably.

### Is it stable stable? 🐎🐎

No. I'm sure you can make it crash given enough effort, but it's pretty okay stability wise for your average TCP request coming from epoxy client or libcurl.js.

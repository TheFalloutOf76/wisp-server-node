import { IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import net, { Socket } from "node:net";
import dns from "node:dns/promises";
import dgram from "node:dgram";
import FrameParsers from "./Packets.js";
import { STREAM_TYPE, PACKET_TYPE, LOG_LEVEL, WispFrame, WispOptions } from "./Types.js";
import { Logger } from "./utils/Logger.js";
import { handleWsProxy } from "./wsproxy.js";
import { checkErrorCode } from "./utils/Error.js";

import { SocksClient } from 'socks';

const wss = new WebSocketServer({ noServer: true });
const defaultOptions: WispOptions = { logLevel: LOG_LEVEL.INFO, pingInterval: 30 };
// Accepts either routeRequest(ws) or routeRequest(request, socket, head) like bare
export async function routeRequest(
    wsOrIncomingMessage: WebSocket | IncomingMessage,
    socket?: Socket,
    head?: Buffer,
    options: WispOptions = defaultOptions,
) {
    options = Object.assign({}, defaultOptions, options);

    if (!(wsOrIncomingMessage instanceof WebSocket) && socket && head) {
        // Wsproxy is handled here because if we're just passed the websocket then we don't even know it's URL
        // Compatibility with bare like "handle upgrade" syntax
        wss.handleUpgrade(wsOrIncomingMessage, socket as Socket, head, (ws: WebSocket): void => {
            if (!wsOrIncomingMessage.url?.endsWith("/")) {
                // disable wsproxy
                return;
                // @ts-ignore

                // if a URL ends with / then its not a wsproxy connection, its wisp
                handleWsProxy(ws, wsOrIncomingMessage.url!);
                return;
            }
            routeRequest(ws, undefined, undefined, options);
        });
        return;
    }

    if (!(wsOrIncomingMessage instanceof WebSocket)) return; // something went wrong, abort

    const ws = wsOrIncomingMessage as WebSocket; // now that we are SURE we have a Websocket object, continue...

    const connections = new Map();
    const logger = new Logger(options.logLevel);
    const pingInterval = setInterval(() => {
        logger.debug(`sending websocket ping`);
        ws.ping();
    }, options.pingInterval * 1000);

    ws.on("message", async (data: any) => {
        try {
            // Ensure that the incoming data is a valid WebSocket message
            if (!Buffer.isBuffer(data) && !(data instanceof ArrayBuffer)) {
                logger.error("Invalid WebSocket message data");
                return;
            }

            const wispFrame = FrameParsers.wispFrameParser(Buffer.from(data as Buffer));

            // Routing
            if (wispFrame.type === PACKET_TYPE.CONNECT) {
                // CONNECT frame data
                const connectFrame = FrameParsers.connectPacketParser(wispFrame.payload);

                if (connectFrame.streamType === STREAM_TYPE.TCP) {
                    let socketReady;
                    const socketStatus = new Promise((resolve) => socketReady = resolve);
                    const connector = {
                        client: null as Socket | null,
                        buffer: 127,
                        ready: socketStatus,
                    }
                    connections.set(wispFrame.streamID, connector);

                    if (options?.blacklist) {
                        const isIp = net.isIP(connectFrame.hostname);
                        if (!isIp && options.blacklist.domains?.includes(connectFrame.hostname)) {
                            connections.delete(wispFrame.streamID);
                            ws.send(FrameParsers.closePacketMaker(wispFrame, 0x03));
                            return;
                        }

                        const resolvedIp = isIp ? connectFrame.hostname :
                            (await Promise.any([
                                dns.resolve4(connectFrame.hostname),
                                dns.resolve6(connectFrame.hostname),
                            ]).catch(() => { }))?.[0];

                        if (resolvedIp && options.blacklist.ips?.includes(resolvedIp)) {
                            connections.delete(wispFrame.streamID);
                            ws.send(FrameParsers.closePacketMaker(wispFrame, 0x03));
                            return;
                        }
                    }

                    if (options?.proxy) {
                        const info = SocksClient.createConnection({
                            proxy: {
                                host: options.proxy.host,
                                port: options.proxy.port,
                                type: 5,
                            },

                            command: 'connect',

                            destination: {
                                host: connectFrame.hostname,
                                port: connectFrame.port,
                            },
                        });

                        // get the socket from the proxy connection
                        try {
                            connector.client = (await info).socket;
                        } catch (e) {
                            connections.delete(wispFrame.streamID);
                            ws.send(FrameParsers.closePacketMaker(wispFrame, 0x03));
                            return;
                        }
                    } else {
                        // Initialize and register Socket that will handle this stream
                        connector.client = new net.Socket();
                        connector.client.connect(connectFrame.port, connectFrame.hostname);
                    }

                    // Send Socket's data back to client
                    connector.client.on("data", function (data) {
                        ws.send(FrameParsers.dataPacketMaker(wispFrame, data));
                    });

                    // Close stream if there is some network error
                    connector.client.on("error", function (err) {
                        logger.error(
                            `An error occured in the connection to ${connectFrame.hostname} (${wispFrame.streamID}) with the message ${err.message}`,
                        );
                        ws.send(FrameParsers.closePacketMaker(wispFrame, checkErrorCode(err)));
                        connections.delete(wispFrame.streamID);
                    });

                    connector.client.on("close", function () {
                        if (connections.get(wispFrame.streamID)) {
                            ws.send(FrameParsers.closePacketMaker(wispFrame, 0x02));
                            connections.delete(wispFrame.streamID);
                        }
                    });

                    // @ts-ignore
                    socketReady();
                } else if (connectFrame.streamType === STREAM_TYPE.UDP) {
                    // disable UDP
                    return;
                    // @ts-ignore

                    let iplevel = net.isIP(connectFrame.hostname); // Can be 0: DNS NAME, 4: IPv4, 6: IPv6
                    let host = connectFrame.hostname;

                    if (iplevel === 0) {
                        // is DNS
                        try {
                            host = (await dns.resolve(connectFrame.hostname))[0];
                            iplevel = net.isIP(host); // can't be 0 now
                        } catch (e) {
                            logger.error(
                                "Failure while trying to resolve hostname " +
                                connectFrame.hostname +
                                " with error: " +
                                e,
                            );
                            ws.send(FrameParsers.closePacketMaker(wispFrame, 0x42));
                            return; // we're done here, ignore doing anything to this message now.
                        }
                    }

                    // iplevel is now guaranteed to be 6 or 4, fingers crossed, so we can define the UDP type now
                    if (iplevel !== 4 && iplevel !== 6) {
                        return; // something went wrong.. neither ipv4 nor ipv6
                    }

                    // Create a new UDP socket
                    const client = dgram.createSocket(iplevel === 6 ? "udp6" : "udp4");
                    client.connect(connectFrame.port, host);
                    //@ts-expect-error stupid workaround
                    client.connected = false;

                    client.on("connect", () => {
                        //@ts-expect-error really dumb workaround
                        client.connected = true;
                    });
                    // Handle incoming UDP data
                    client.on("message", (data, rinfo) => {
                        ws.send(FrameParsers.dataPacketMaker(wispFrame, data));
                    });

                    // Handle errors
                    client.on("error", (err) => {
                        logger.error(
                            `An error occured in the connection to ${connectFrame.hostname} (${wispFrame.streamID}) with the message ${err.message}`,
                        );
                        ws.send(FrameParsers.closePacketMaker(wispFrame, checkErrorCode(err)));
                        connections.delete(wispFrame.streamID);
                        client.close();
                    });

                    client.on("close", function () {
                        if (connections.get(wispFrame.streamID)) {
                            ws.send(FrameParsers.closePacketMaker(wispFrame, 0x02));
                            connections.delete(wispFrame.streamID);
                        }
                    });

                    // Store the UDP socket and connectFrame in the connections map
                    connections.set(wispFrame.streamID, {
                        client,
                    });
                }
            }

            if (wispFrame.type === PACKET_TYPE.DATA) {
                const stream = connections.get(wispFrame.streamID);
                if (!stream) { return; }
                await stream.ready;

                if (stream && stream.client instanceof net.Socket) {
                    stream.client.write(wispFrame.payload);
                    stream.buffer--;
                    if (stream.buffer === 0) {
                        stream.buffer = 127;
                        ws.send(FrameParsers.continuePacketMaker(wispFrame, stream.buffer));
                    }
                } else if (stream && stream.client instanceof dgram.Socket) {
                    stream.client.send(wispFrame.payload, undefined, undefined, (err: Error | null) => {
                        if (err) {
                            ws.send(FrameParsers.closePacketMaker(wispFrame, checkErrorCode(err)));
                            if (stream.client.connected) {
                                stream.client.close();
                            }
                            connections.delete(wispFrame.streamID);
                        }
                    });
                }
            }

            if (wispFrame.type === PACKET_TYPE.CLOSE) {
                // its joever
                logger.log(
                    "Client decided to terminate with reason " + new DataView(wispFrame.payload.buffer).getUint8(0),
                );
                const stream = connections.get(wispFrame.streamID);
                if (stream && stream.client instanceof net.Socket) {
                    stream.client.destroy();
                } else if (stream && stream.client instanceof dgram.Socket) {
                    stream.client.close();
                }
                connections.delete(wispFrame.streamID);
            }
        } catch (e) {
            ws.close(); // something went SUPER wrong, like its probably not even a wisp connection
            logger.error(`WISP incoming message handler error: `, e);

            // cleanup
            for (const { client } of connections.values()) {
                if (client instanceof net.Socket) {
                    client.destroy();
                } else if (client instanceof dgram.Socket) {
                    client.close();
                }
            }
            connections.clear();
        }
    });

    // Close all open sockets when the WebSocket connection is closed
    ws.on("close", (code: number, reason: string) => {
        logger.debug(`WebSocket connection closed with code ${code} and reason: ${reason}`);
        for (const { client } of connections.values()) {
            if (client instanceof net.Socket) {
                client.destroy();
            } else if (client instanceof dgram.Socket) {
                client.close();
            }
        }
        connections.clear();
        clearTimeout(pingInterval);
    });

    // SEND the initial continue packet with streamID 0 and 127 queue limit
    ws.send(FrameParsers.continuePacketMaker({ streamID: 0 } as WispFrame, 127));
}

export default {
    routeRequest,
};

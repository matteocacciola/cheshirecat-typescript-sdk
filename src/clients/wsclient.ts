import WebSocket from "isomorphic-ws";
import {Uri} from "./uri";
import {EventEmitter} from "events";

export class WSClient {
    protected host: string;
    protected port?: number | null = null;
    protected apikey?: string | null = null;
    protected token?: string | null = null;
    protected isWSS: boolean;

    constructor(
        host: string,
        port?: number | null,
        apikey?: string | null,
        isWSS: boolean = false
    ) {
        this.host = host;
        this.port = port;
        this.apikey = apikey;
        this.token = null;
        this.isWSS = isWSS;
    }

    public setToken(token: string): this {
        this.token = token;
        return this;
    }

    public getClient(agentId?: string, userId?: string): WebSocketClient {
        if (!this.apikey && !this.token) {
            throw new Error("You must provide an apikey or a token");
        }

        return this.createWsClient(agentId, userId);
    }

    public getWsUri(agentId?: string, userId?: string): Uri {
        const query: Record<string, string> = {};

        if (this.token) {
            query["token"] = this.token;
        } else {
            query["apikey"] = this.apikey!;
        }

        if (userId) {
            query["user_id"] = userId;
        }

        return new Uri()
            .withScheme(this.isWSS ? "wss" : "ws")
            .withHost(this.host)
            .withPath(`ws/${agentId ?? ""}`)
            .withQueryItems(query)
            .withPort(this.port);
    }

    protected createWsClient(agentId?: string, userId?: string): WebSocketClient {
        return new WebSocketClient(this.getWsUri(agentId, userId).toString());
    }
}

interface WebSocketClientEvents {
    open: () => void;
    close: (code: number, reason: string) => void;
    error: (error: Error) => void;
    message: (data: WebSocket.Data) => void;
    pong: () => void;
}

export class WebSocketClient extends EventEmitter {
    private ws: WebSocket;
    private pingInterval?: ReturnType<typeof setInterval>;
    private pongTimeout?: ReturnType<typeof setTimeout>;
    private reconnectAttempts: number = 0;
    private readonly maxReconnectAttempts: number = 5;
    private readonly pingIntervalMs: number = 30000;
    private readonly pongTimeoutMs: number = 5000;

    constructor(url: string) {
        super();
        this.ws = this.connect(url);
        this.setupPingPong();
        this.setupEventHandlers();
    }

    public on<K extends keyof WebSocketClientEvents>(
        event: K,
        listener: WebSocketClientEvents[K]
    ): this {
        return super.on(event, listener);
    }

    public emit<K extends keyof WebSocketClientEvents>(
        event: K,
        ...args: Parameters<WebSocketClientEvents[K]>
    ): boolean {
        return super.emit(event, ...args);
    }

    private connect(url: string): WebSocket {
        return new WebSocket(url);
    }

    private setupPingPong(): void {
        if (typeof this.ws.ping === "function") {
            this.pingInterval = setInterval(() => {
                if (this.ws.readyState === WebSocket.OPEN) {
                    this.ws.ping();
                }
            }, this.pingIntervalMs);
            return;
        }

        this.pingInterval = setInterval(() => {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));

                this.pongTimeout = setTimeout(() => {
                    this.handleConnectionLost();
                }, this.pongTimeoutMs);
            }
        }, this.pingIntervalMs);
    }

    private handleConnectionLost(): void {
        this.ws.close(1000, "Connection lost - no pong received");

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            setTimeout(() => {
                this.ws = this.connect(this.ws.url);
                this.setupEventHandlers();
            }, 1000 * this.reconnectAttempts);
        }
    }

    private setupEventHandlers(): void {
        this.ws.onopen = () => {
            this.reconnectAttempts = 0;
            this.emit("open");
        };

        this.ws.onclose = (event) => {
            this.handleClose(event.code, event.reason);
        };

        this.ws.onerror = (event: WebSocket.ErrorEvent) => {
            const error = new Error("WebSocket error occurred");
            error.cause = event;
            this.emit("error", error);
        };

        this.ws.onmessage = (event: WebSocket.MessageEvent) => {
            try {
                const data = JSON.parse(event.data.toString());

                if (data.type === "ping") {
                    this.ws.send(JSON.stringify({
                        type: "pong",
                        timestamp: data.timestamp
                    }));
                    return;
                }
                if (data.type === "pong") {
                    if (this.pongTimeout) {
                        clearTimeout(this.pongTimeout);
                        this.pongTimeout = undefined;
                    }
                    this.emit("pong");
                    return;
                }
                this.emit("message", event.data);
            } catch (e) {
                this.emit("message", event.data);
            }
        };

        if (typeof this.ws.on === "function") {
            this.ws.on("pong", () => {
                this.emit("pong");
            });
        }
    }

    private handleClose(code: number, reason: string): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
        }
        if (this.pongTimeout) {
            clearTimeout(this.pongTimeout);
        }

        this.emit("close", code, reason);

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            setTimeout(() => {
                this.ws = this.connect(this.ws.url);
                this.setupEventHandlers();
            }, 1000 * this.reconnectAttempts);
        }
    }

    public send(data: string | Uint8Array): void {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(data);
        } else {
            throw new Error("WebSocket is not open");
        }
    }

    public close(code?: number, reason?: string): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
        }
        this.ws.close(code, reason);
    }
}
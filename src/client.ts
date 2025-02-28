import {
    composeContext,
    elizaLogger,
    generateObject,
    stringToUuid,
    type ClientInstance,
    type Client,
    type Content,
    type IAgentRuntime,
    type Memory,
    type Plugin,
    ModelClass,
} from "@elizaos/core";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { z } from "zod";

export const hyperfyHandlerTemplate = `{{actionExamples}}
(Action examples are for reference only. Do not use the information from them in your response.)

# Knowledge
{{knowledge}}

# About {{agentName}}:
{{bio}}
{{lore}}

{{providers}}

{{attachments}}

# Capabilities
Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

{{messageDirections}}

{{recentMessages}}

{{actions}}

# Context
You are currently an embodied avatar in someones Hyperfy virtual world.
This is the context for the environment and a list of recent events:
{{hyperfy}}

# Task: Decide if you would like to respond to the context above which describes the world and recent events. If you choose to respond, only say short messages, eg less than 100 characters. If it doesn't seem like anyone is talking to you, stay quiet. NEVER RESPOND IF ONLY AGENTS HAVE SPOKEN THE LAST FEW MESSAGES.

Response format should be formatted in a JSON block like this:
\`\`\`json
{ "look": "string" player id or null, "emote": "{{emotes}}" or null, "say": "string" or null, "trigger": "{{triggers}}" or null }
\`\`\`
`;

export class HyperfyClient {
    public app: express.Application;
    private agents: Map<string, IAgentRuntime>; // container management
    private server: any; // Store server instance
    private port: number;

    constructor(port: number = 3001) {
        elizaLogger.info("HyperfyClient constructor");
        this.app = express();
        this.app.use(cors());
        this.agents = new Map();
        this.port = port;

        this.app.use(bodyParser.json());
        this.app.use(bodyParser.urlencoded({ extended: true }));

        // Route to check if server is running
        this.app.get("/health", (req, res) => {
            res.json({ status: "ok", agents: Array.from(this.agents.keys()) });
        });

        this.app.post(
            "/agents/:agentIdOrName/hyperfy",
            async (req: express.Request, res: express.Response) => {
                // get runtime
                const agentId = req.params.agentIdOrName;
                let runtime = this.agents.get(agentId);

                // if runtime is null, look for runtime with the same name
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }

                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }

                // can we be in more than one hyperfy world at once
                // but you may want the same context is multiple worlds
                // this is more like an instanceId
                const roomId = stringToUuid(req.body.roomId ?? "hyperfy");
                const body = req.body || {};

                console.log("BODY", body);

                const content: Content = {
                    // we need to compose who's near and what emotes are available
                    text: JSON.stringify(req.body),
                    attachments: [],
                    source: "hyperfy",
                    inReplyTo: undefined,
                };

                const userId = stringToUuid("hyperfy");
                const userMessage = {
                    content,
                    userId,
                    roomId,
                    agentId: runtime.agentId,
                };

                const state = await runtime.composeState(userMessage, {
                    agentName: runtime.character.name,
                });

                let template = hyperfyHandlerTemplate;
                template = template.replace(
                    "{{hyperfy}}",
                    JSON.stringify(body, null, 2)
                );
                template = template.replace(
                    "{{emotes}}",
                    body.emotes.join("|")
                );
                template = template.replace(
                    "{{triggers}}",
                    body.triggers.join("|")
                );

                // console.log("TEMPLATE", template);
                const context = composeContext({
                    state,
                    template,
                });

                function createHyperfyOutSchema(body: any) {
                    // Extract emotes and triggers from the body
                    const emotes = body.emotes || [];
                    const triggers = body.triggers || [];

                    // Either accept any string (if triggers are empty) or the specific trigger values
                    const lookAtSchema =
                        triggers.length > 0
                            ? z.union([
                                z.union(
                                    triggers.map((item: string) =>
                                        z.literal(item)
                                    ) as [
                                        z.ZodLiteral<string>,
                                        ...z.ZodLiteral<string>[]
                                    ]
                                ),
                                z.string(), // Allow any string
                                z.null(), // Also allow null
                            ])
                            : z.union([z.string(), z.null()]); // If no triggers, allow any string or null

                    // Either accept any string (if emotes are empty) or the specific emote values
                    const emoteSchema =
                        emotes.length > 0
                            ? z.union([
                                z.union(
                                    emotes.map((item: string) =>
                                        z.literal(item)
                                    ) as [
                                        z.ZodLiteral<string>,
                                        ...z.ZodLiteral<string>[]
                                    ]
                                ),
                                z.string(), // Allow any string
                                z.null(), // Also allow null
                            ])
                            : z.union([z.string(), z.null()]); // If no emotes, allow any string or null

                    return z.object({
                        lookAt: lookAtSchema,
                        emote: emoteSchema,
                        say: z.string().nullable(),
                        actions: z.array(z.string()).nullable(),
                    });
                }

                // Define the schema for the expected output
                const hyperfyOutSchema = createHyperfyOutSchema(body);

                // Call LLM
                const response = await generateObject({
                    runtime,
                    context,
                    modelClass: ModelClass.SMALL, // 1s processing time on openai small
                    schema: hyperfyOutSchema,
                });

                if (!response) {
                    res.status(500).send(
                        "No response from generateMessageResponse"
                    );
                    return;
                }

                let hfOut;
                try {
                    hfOut = hyperfyOutSchema.parse(response.object);
                } catch {
                    elizaLogger.error(
                        "cant serialize response",
                        response.object
                    );
                    res.status(500).send("Error in LLM response, try again");
                    return;
                }

                // do this in the background
                new Promise((resolve) => {
                    const contentObj: Content = {
                        text: hfOut.say,
                    };

                    if (hfOut.lookAt !== null || hfOut.emote !== null) {
                        contentObj.text += ". Then I ";
                        if (hfOut.lookAt !== null) {
                            contentObj.text += "looked at " + hfOut.lookAt;
                            if (hfOut.emote !== null) {
                                contentObj.text += " and ";
                            }
                        }
                        if (hfOut.emote !== null) {
                            contentObj.text = "emoted " + hfOut.emote;
                        }
                    }

                    if (hfOut.actions !== null) {
                        // content can only do one action
                        contentObj.action = hfOut.actions[0];
                    }

                    // save response to memory
                    const responseMessage = {
                        ...userMessage,
                        userId: runtime.agentId,
                        content: contentObj,
                    };

                    runtime.messageManager
                        .createMemory(responseMessage)
                        .then(() => {
                            const messageId = stringToUuid(
                                Date.now().toString()
                            );
                            const memory: Memory = {
                                id: messageId,
                                agentId: runtime.agentId,
                                userId,
                                roomId,
                                content,
                                createdAt: Date.now(),
                            };

                            // run evaluators (generally can be done in parallel with processActions)
                            // can an evaluator modify memory? it could but currently doesn't
                            runtime.evaluate(memory, state).then(() => {
                                // only need to call if responseMessage.content.action is set
                                if (contentObj.action) {
                                    // pass memory (query) to any actions to call
                                    runtime.processActions(
                                        memory,
                                        [responseMessage],
                                        state,
                                        async (_newMessages) => {
                                            // FIXME: this is supposed override what the LLM said/decided
                                            // but the promise doesn't make this possible
                                            //message = newMessages;
                                            return [memory];
                                        }
                                    ); // 0.674s
                                }
                                resolve(true);
                            });
                        });
                });
                res.json(hfOut);
            }
        );
    }

    public registerAgent(runtime: IAgentRuntime) {
        elizaLogger.info(`HyperfyClient: Registering agent ${runtime.agentId}`);
        this.agents.set(runtime.agentId, runtime);
    }

    public unregisterAgent(runtime: IAgentRuntime) {
        elizaLogger.info(
            `HyperfyClient: Unregistering agent ${runtime.agentId}`
        );
        this.agents.delete(runtime.agentId);
    }

    public start() {
        this.server = this.app.listen(this.port, () => {
            elizaLogger.info(
                `Hyperfy REST API bound to 0.0.0.0:${this.port}. If running locally, access it at http://localhost:${this.port}.`
            );
        });

        // Handle graceful shutdown
        const gracefulShutdown = () => {
            elizaLogger.info(
                "Received shutdown signal, closing Hyperfy server..."
            );
            this.server.close(() => {
                elizaLogger.info("Hyperfy server closed successfully");
                // Note: We don't exit the process here as that would stop the main application
            });
        };

        // We don't attach to process signals here because the main application should handle that
        return this;
    }

    public async stop() {
        if (this.server) {
            return new Promise<void>((resolve) => {
                this.server.close(() => {
                    elizaLogger.info("Hyperfy server stopped");
                    resolve();
                });
            });
        }
    }
}

export const HyperfyClientInterface: Client = {
    name: "hyperfy",
    config: {},
    start: async (runtime: IAgentRuntime) => {
        elizaLogger.info("Starting HyperfyClientInterface");
        // Use a different port than the main server (which uses 3000 by default)
        const serverPort = Number.parseInt(
            process.env.HYPERFY_SERVER_PORT || "3001"
        );

        const client = new HyperfyClient(serverPort);
        client.registerAgent(runtime);
        client.start();

        return {
            client,
            stop: async () => {
                elizaLogger.info("Stopping HyperfyClientInterface");
                client.unregisterAgent(runtime);
                await client.stop();
            },
        } as ClientInstance;
    },
};

const hyperfyPlugin: Plugin = {
    name: "hyperfy",
    description: "Hyperfy client for virtual worlds",
    clients: [HyperfyClientInterface],
};

export default hyperfyPlugin;


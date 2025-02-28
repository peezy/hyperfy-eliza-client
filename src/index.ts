import { Plugin } from "@elizaos/core";
import { HyperfyClientInterface } from "./client";

const hyperfyPlugin: Plugin = {
    name: "hyperfy",
    description: "Hyperfy client plugin",
    clients: [HyperfyClientInterface]
};
export default hyperfyPlugin;

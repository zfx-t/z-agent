/** Built-in interactive commands, inspired by PI's slash registry and OpenCode's command palette. */
export interface InteractiveCommand {
	name: string;
	description: string;
}

export const INTERACTIVE_COMMANDS: readonly InteractiveCommand[] = [
	{ name: "/new", description: "Start a fresh conversation" },
	{ name: "/reset", description: "Reset agent context" },
	{ name: "/clear", description: "Clear visible transcript" },
	{ name: "/compact", description: "Compact the active context" },
	{ name: "/sessions", description: "Browse and resume saved sessions" },
	{ name: "/status", description: "Show runtime status" },
	{ name: "/commands", description: "Browse available commands" },
	{ name: "/exit", description: "Exit z-agent" },
];

export function commandMenuItems(commands: readonly InteractiveCommand[] = INTERACTIVE_COMMANDS): string[] {
	const longest = Math.max(...commands.map((command) => command.name.length));
	return commands.map((command) => `${command.name.padEnd(longest)}  ${command.description}`);
}

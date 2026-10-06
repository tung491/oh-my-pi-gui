import { createInterface } from "node:readline";
import { createShowcaseData, isShowcaseScenario } from "./showcase-data";

const locale = process.env.OMP_SHOWCASE_LANG === "vi" ? "vi" : "en";
const scenario = process.env.OMP_SHOWCASE_SCENARIO;
if (!isShowcaseScenario(scenario)) {
	process.stderr.write(`Unknown showcase scenario: ${scenario ?? "(unset)"}\n`);
	process.exit(2);
}
const data = createShowcaseData(locale, process.env.OMP_SHOWCASE_PROJECT ?? process.cwd(), scenario);
const replies: Record<string, unknown> = data.replies;

const write = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`);
write({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] });
const input = createInterface({ input: process.stdin });
input.on("line", line => {
	let command: { id?: string; type: string };
	try {
		command = JSON.parse(line) as { id?: string; type: string };
	} catch {
		process.stderr.write(`Unreadable showcase command: ${line}\n`);
		return;
	}
	if (Object.hasOwn(replies, command.type)) {
		write({ type: "response", id: command.id, command: command.type, success: true, data: replies[command.type] });
	} else if (["set_subagent_subscription", "set_host_tools", "set_host_uri_schemes", "abort"].includes(command.type)) {
		write({ type: "response", id: command.id, command: command.type, success: true, data: {} });
	} else {
		process.stderr.write(`Unscripted showcase command: ${command.type}\n`);
		write({
			type: "response",
			id: command.id,
			command: command.type,
			success: false,
			error:
				locale === "vi"
					? "Thao tác này không được bật trong kịch bản minh họa"
					: "This action is not enabled in the demonstration",
		});
	}
});

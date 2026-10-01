import { parseHTML } from "linkedom";
import { X } from "lucide-react";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { RadioGroup } from "../settings/editors/RadioGroup";
import { IconButton } from "./IconButton";
import { Kbd } from "./Kbd";
import { ProgressBar } from "./ProgressBar";
import { SegmentedControl } from "./SegmentedControl";
import { StepList } from "./StepList";
import { Tag } from "./Tag";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

/** Structural stand-in for linkedom nodes, keeping tests decoupled from its types. */
interface TestElement {
	textContent: string | null;
	checked?: boolean;
	remove: () => void;
	getAttribute: (name: string) => string | null;
	dispatchEvent: (event: object) => boolean;
	querySelector: (selector: string) => TestElement | null;
	querySelectorAll: (selector: string) => Iterable<TestElement>;
}

/** Today's settings markup for a two-option group, so the default variant stays byte-identical. */
const COMPACT_MARKUP =
	'<div class="space-y-1" role="radiogroup"><label class="flex cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 transition-colors border-(--omp-border-accent) bg-[color-mix(in_srgb,var(--omp-link)_8%,transparent)]"><input class="mt-0.5 accent-(--omp-accent)" type="radio" name="density" checked=""/><span class="min-w-0"><span class="block text-xs font-medium text-(--omp-text)">A</span><span class="mt-0.5 block text-omp-sm leading-snug text-(--omp-muted)">First</span></span></label><label class="flex cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 transition-colors border-(--omp-border-muted) hover:bg-(--omp-bg-tertiary)"><input class="mt-0.5 accent-(--omp-accent)" type="radio" name="density"/><span class="min-w-0"><span class="block text-xs font-medium text-(--omp-text)">B</span></span></label></div>';

let container: TestElement;
let root: Root;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

function query(selector: string): TestElement {
	const element = container.querySelector(selector);
	if (!element) throw new Error(`no element matches ${selector}`);
	return element;
}

function queryAll(selector: string): TestElement[] {
	return [...container.querySelectorAll(selector)];
}

/** Dispatch inside act(); linkedom's Event has a getter-only eventPhase React writes to. */
async function dispatch(target: TestElement, event: InstanceType<typeof Event>): Promise<void> {
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
}

async function click(element: TestElement): Promise<void> {
	await dispatch(element, new Event("click", { bubbles: true, cancelable: true }));
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
});

describe("IconButton", () => {
	it("renders a labelled button that reports clicks", async () => {
		const onClick = vi.fn();
		await mount(<IconButton icon={<X />} label="Close" onClick={onClick} />);
		const button = query("button");
		expect(button.getAttribute("type")).toBe("button");
		expect(button.getAttribute("aria-label")).toBe("Close");
		expect(button.getAttribute("title")).toBe("Close");
		await click(button);
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it("exposes its variant as a data attribute", async () => {
		await mount(<IconButton icon={<X />} label="Close" variant="onDark" />);
		expect(query("button").getAttribute("data-variant")).toBe("onDark");
	});
});

describe("Kbd", () => {
	it("renders a hidden key hint with its text", async () => {
		await mount(<Kbd>⌘K</Kbd>);
		const kbd = query("kbd");
		expect(kbd.getAttribute("aria-hidden")).toBe("true");
		expect(kbd.textContent).toBe("⌘K");
	});
});

describe("RadioGroup", () => {
	const providerOptions = [
		{ value: "a", label: "A" },
		{ value: "b", label: "B", badge: <span data-testid="b-badge" /> },
	] satisfies { value: "a" | "b"; label: string; badge?: ReactElement }[];

	it("renders a labelled card group whose radios share one name", async () => {
		await mount(
			<RadioGroup
				label="Provider"
				name="provider"
				onChange={() => {}}
				options={providerOptions}
				value="a"
				variant="card"
			/>,
		);
		expect(query('[role="radiogroup"]').getAttribute("aria-label")).toBe("Provider");
		const radios = queryAll('input[type="radio"]');
		expect(radios).toHaveLength(2);
		expect(radios.map(radio => radio.getAttribute("name"))).toEqual(["provider", "provider"]);
		expect(container.querySelector('[data-testid="b-badge"]')).not.toBeNull();
	});

	it("reports the option the user picks", async () => {
		const onChange = vi.fn();
		await mount(
			<RadioGroup
				label="Provider"
				name="provider"
				onChange={onChange}
				options={providerOptions}
				value="a"
				variant="card"
			/>,
		);
		const second = queryAll('input[type="radio"]')[1];
		second.checked = true;
		await click(second);
		expect(onChange).toHaveBeenLastCalledWith("b");
	});

	it("renders an option description as text", async () => {
		await mount(
			<RadioGroup
				label="Provider"
				name="provider"
				onChange={() => {}}
				options={[{ value: "custom", label: "Custom", description: "Point omp at your own endpoint" }]}
				value="custom"
				variant="card"
			/>,
		);
		expect(query('[role="radiogroup"]').textContent).toContain("Point omp at your own endpoint");
	});

	it("keeps the settings markup when no label or variant is given", () => {
		const html = renderToStaticMarkup(
			<RadioGroup
				name="density"
				onChange={() => {}}
				options={[
					{ value: "a", label: "A", description: "First" },
					{ value: "b", label: "B" },
				]}
				value="a"
			/>,
		);
		expect(html).toContain('role="radiogroup"');
		expect(html).not.toContain("aria-label");
		expect(html).toBe(COMPACT_MARKUP);
	});
});

describe("SegmentedControl", () => {
	function ModeControl({ onChange }: { onChange: (value: "code" | "work") => void }) {
		const [mode, setMode] = useState<"code" | "work">("code");
		return (
			<SegmentedControl
				ariaLabel="Mode"
				onChange={next => {
					onChange(next);
					setMode(next);
				}}
				options={[
					{ value: "code", label: "Code", title: "Project sessions", icon: <span data-testid="code-icon" /> },
					{ value: "work", label: "Work", title: "Default workspace" },
				]}
				value={mode}
			/>
		);
	}

	it("renders a labelled group of pressed-state buttons", async () => {
		await mount(<ModeControl onChange={() => {}} />);
		expect(query('[role="group"]').getAttribute("aria-label")).toBe("Mode");
		const buttons = queryAll('[role="group"] button');
		expect(buttons.map(button => button.textContent)).toEqual(["Code", "Work"]);
		expect(buttons.map(button => button.getAttribute("type"))).toEqual(["button", "button"]);
		expect(buttons.map(button => button.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
		expect(buttons.map(button => button.getAttribute("title"))).toEqual(["Project sessions", "Default workspace"]);
		expect(container.querySelector('[data-testid="code-icon"]')).not.toBeNull();
	});

	it("reports the clicked option and moves the pressed state", async () => {
		const onChange = vi.fn();
		await mount(<ModeControl onChange={onChange} />);
		await click(queryAll('[role="group"] button')[1]);
		expect(onChange).toHaveBeenLastCalledWith("work");
		expect(queryAll('[role="group"] button').map(button => button.getAttribute("aria-pressed"))).toEqual([
			"false",
			"true",
		]);
	});
});

describe("Tag", () => {
	function FilterTag({ onClick }: { onClick: () => void }) {
		const [selected, setSelected] = useState(false);
		return (
			<Tag
				onClick={() => {
					onClick();
					setSelected(value => !value);
				}}
				selected={selected}
			>
				Running 2
			</Tag>
		);
	}

	it("is a toggle button whose pressed state follows selected", async () => {
		const onClick = vi.fn();
		await mount(<FilterTag onClick={onClick} />);
		const tag = query("button");
		expect(tag.textContent).toBe("Running 2");
		expect(tag.getAttribute("aria-pressed")).toBe("false");
		await click(tag);
		expect(onClick).toHaveBeenCalledTimes(1);
		expect(query("button").getAttribute("aria-pressed")).toBe("true");
		await click(query("button"));
		expect(query("button").getAttribute("aria-pressed")).toBe("false");
	});
});

describe("ProgressBar", () => {
	it("marks the brand fill and keeps its progressbar role", async () => {
		await mount(<ProgressBar fill="brand" value={0.5} />);
		const bar = query('[role="progressbar"]');
		expect(bar.getAttribute("data-fill")).toBe("brand");
		expect(bar.getAttribute("aria-valuenow")).toBe("0.5");
	});
});

describe("StepList", () => {
	it("renders an ordered list that marks only the current step", async () => {
		await mount(<StepList ariaLabel="Setup steps" current={1} steps={["Welcome", "Connect", "Models"]} />);
		expect(query("nav").getAttribute("aria-label")).toBe("Setup steps");
		const items = queryAll("nav ol li");
		expect(items.map(item => item.textContent)).toEqual(["Welcome", "Connect", "Models"]);
		expect(items.map(item => item.getAttribute("aria-current"))).toEqual([null, "step", null]);
	});
});

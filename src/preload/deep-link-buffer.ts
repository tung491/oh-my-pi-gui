/**
 * Holds a deep link that reaches the preload before the renderer subscribes.
 * Main sends a cold-start link once, at did-finish-load, while the renderer
 * subscribes only from an effect after its first render; ipcRenderer drops a
 * message nobody listens for. Latest wins: links that land before the first
 * subscription open one target, not each in turn.
 */
export class DeepLinkBuffer<T> {
	#pending: T | undefined;
	readonly #listeners = new Set<(link: T) => void>();

	deliver(link: T): void {
		if (this.#listeners.size === 0) {
			this.#pending = link;
			return;
		}
		for (const listener of this.#listeners) listener(link);
	}

	subscribe(listener: (link: T) => void): () => void {
		this.#listeners.add(listener);
		const pending = this.#pending;
		this.#pending = undefined;
		if (pending !== undefined) listener(pending);
		return () => {
			this.#listeners.delete(listener);
		};
	}
}

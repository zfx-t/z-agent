class ImmutableReadonlyMap<K, V> implements ReadonlyMap<K, V> {
	readonly #values: Map<K, V>;

	constructor(entries: Iterable<readonly [K, V]>) {
		this.#values = new Map(entries);
		Object.freeze(this);
	}

	get size(): number {
		return this.#values.size;
	}

	get(key: K): V | undefined {
		return this.#values.get(key);
	}

	has(key: K): boolean {
		return this.#values.has(key);
	}

	entries(): MapIterator<[K, V]> {
		return this.#values.entries();
	}

	keys(): MapIterator<K> {
		return this.#values.keys();
	}

	values(): MapIterator<V> {
		return this.#values.values();
	}

	forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
		for (const [key, value] of this.#values) {
			callback.call(thisArg, value, key, this);
		}
	}

	[Symbol.iterator](): MapIterator<[K, V]> {
		return this.entries();
	}
}

export function immutableMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
	return new ImmutableReadonlyMap(entries);
}

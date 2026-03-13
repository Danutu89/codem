/**
 * Global store for detected dev server URLs.
 *
 * Detection happens in the root EventRouter (which is never remounted by HMR),
 * so it's reliable even during development. The ThreadTerminalDrawer reads
 * from this store to show the banner.
 */
import { create } from "zustand";
import { detectDevServerUrl, stripAnsi } from "./devServerDetector";

interface DevServerStoreState {
	/** Map of threadId → detected dev server URL */
	detectedUrls: Record<string, string>;
	/** Map of threadId → output buffer for URL detection */
	_buffers: Record<string, string>;

	/** Process a terminal output event — accumulate and scan for URLs */
	processOutput: (threadId: string, data: string) => void;
	/** Reset detection for a thread (e.g. on terminal restart) */
	resetThread: (threadId: string) => void;
	/** Clear a detected URL (e.g. user dismissed the banner) */
	clearUrl: (threadId: string) => void;
}

export const useDevServerStore = create<DevServerStoreState>((set, get) => ({
	detectedUrls: {},
	_buffers: {},

	processOutput: (threadId: string, data: string) => {
		const state = get();
		console.log(
			`[DevServerStore] Processing output for thread ${threadId}:`,
			data,
		);

		// Already detected for this thread — skip
		if (state.detectedUrls[threadId]) return;

		const buffer = (state._buffers[threadId] ?? "") + data;
		// Keep buffer manageable
		const trimmedBuffer =
			buffer.length > 10_000 ? buffer.slice(-5_000) : buffer;

		const cleanBuffer = stripAnsi(trimmedBuffer);

		console.log(
			`[DevServerStore] Cleaned buffer for thread ${threadId}:`,
			cleanBuffer,
		);

		const url = detectDevServerUrl(cleanBuffer);

		console.log(`[DevServerStore] Detected URL for thread ${threadId}:`, url);

		if (url) {
			set({
				detectedUrls: { ...state.detectedUrls, [threadId]: url },
				_buffers: { ...state._buffers, [threadId]: trimmedBuffer },
			});
		} else {
			// Only update buffer if changed
			if (trimmedBuffer !== state._buffers[threadId]) {
				set({ _buffers: { ...state._buffers, [threadId]: trimmedBuffer } });
			}
		}
	},

	resetThread: (threadId: string) => {
		const state = get();
		const { [threadId]: _url, ...restUrls } = state.detectedUrls;
		const { [threadId]: _buf, ...restBuffers } = state._buffers;
		set({ detectedUrls: restUrls, _buffers: restBuffers });
	},

	clearUrl: (threadId: string) => {
		const state = get();
		if (!state.detectedUrls[threadId]) return;
		const { [threadId]: _url, ...rest } = state.detectedUrls;
		set({ detectedUrls: rest });
	},
}));

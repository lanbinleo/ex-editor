/**
 * API 密钥的落盘加密：桌面端用 Electron safeStorage（Windows 凭据管理器 /
 * macOS Keychain / Linux libsecret）加密后写入 data.json，格式为 `enc:<base64>`。
 *
 * - safeStorage 不可用（移动端 / 无系统密钥库）时明文存储——data.json 已被
 *   .gitignore 排除，不会进入版本库，但会随 vault 同步盘明文上云，属已知妥协。
 * - 密文与设备/系统账户绑定：换电脑、重装系统后无法解密，需要重新输入密钥。
 * - 本模块不依赖 obsidian API（vitest 可直接测试，fake 注入见 setSafeStorageForTest）。
 */

/** safeStorage 的最小结构类型（Electron 实际收发 Buffer，Uint8Array 与之兼容） */
export interface SafeStorageLike {
	isEncryptionAvailable(): boolean;
	encryptString(plainText: string): Uint8Array;
	decryptString(encrypted: Uint8Array): string;
}

const ENC_PREFIX = 'enc:';

/** 当前实现：undefined 未探测 / null 不可用 / SafeStorageLike 可用 */
let impl: SafeStorageLike | null | undefined;

function getImpl(): SafeStorageLike | null {
	if (impl !== undefined) return impl;
	impl = null;
	try {
		// 仅桌面端渲染进程可用（Obsidian 未提供官方密钥库 API，社区通行做法）；
		// Node（vitest）环境无 window，视为不可用，测试通过 setSafeStorageForTest 注入
		const req =
			typeof window === 'undefined'
				? undefined
				: (window as unknown as { require?: (m: string) => unknown }).require;
		const electron = req ? (req('electron') as { safeStorage?: SafeStorageLike }) : undefined;
		if (electron?.safeStorage) impl = electron.safeStorage;
	} catch {
		/* 移动端或受限环境：无 electron 模块 */
	}
	return impl;
}

/** 单测注入 fake 实现；传 null 恢复自动探测 */
export function setSafeStorageForTest(fake: SafeStorageLike | null): void {
	impl = fake;
}

export function isEncryptionAvailable(): boolean {
	try {
		return getImpl()?.isEncryptionAvailable() === true;
	} catch {
		return false;
	}
}

function bytesToBase64(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** 明文 → `enc:<base64>`；加密不可用时原样返回（明文落盘已是兜底策略） */
export function encryptApiKey(plain: string): string {
	if (!plain || plain.startsWith(ENC_PREFIX)) return plain;
	const storage = getImpl();
	if (!storage || !isEncryptionAvailable()) return plain;
	try {
		return ENC_PREFIX + bytesToBase64(storage.encryptString(plain));
	} catch {
		return plain;
	}
}

/**
 * `enc:<base64>` → 明文。非 enc: 前缀（明文存量）原样返回；
 * 解密失败（密文来自其他设备/系统账户）返回 null，调用方应置空并提示重填。
 */
export function decryptApiKey(stored: string): string | null {
	if (!stored.startsWith(ENC_PREFIX)) return stored;
	const storage = getImpl();
	if (!storage) return null;
	try {
		return storage.decryptString(base64ToBytes(stored.slice(ENC_PREFIX.length)));
	} catch {
		return null;
	}
}

import { afterEach, describe, expect, it } from 'vitest';
import {
	decryptApiKey,
	encryptApiKey,
	isEncryptionAvailable,
	setSafeStorageForTest,
} from '../src/storage/secureStore';

afterEach(() => {
	setSafeStorageForTest(null);
});

describe('secureStore（safeStorage 不可用，移动端/默认环境）', () => {
	it('isEncryptionAvailable 为 false', () => {
		expect(isEncryptionAvailable()).toBe(false);
	});

	it('加密原样返回明文，解密对明文原样放行', () => {
		expect(encryptApiKey('sk-plain')).toBe('sk-plain');
		expect(decryptApiKey('sk-plain')).toBe('sk-plain');
		expect(encryptApiKey('')).toBe('');
	});

	it('存量密文无法解密 → null（提示重填）', () => {
		expect(decryptApiKey('enc:bm90LXZhbGlk')).toBeNull();
	});
});

describe('secureStore（fake safeStorage 注入）', () => {
	const fake = {
		isEncryptionAvailable: () => true,
		encryptString: (s: string) => new TextEncoder().encode(`fake(${s})`),
		decryptString: (b: Uint8Array) => {
			const text = new TextDecoder().decode(b);
			if (!text.startsWith('fake(')) throw new Error('bad ciphertext');
			return text.slice(5, -1);
		},
	};

	it('roundtrip：enc: 前缀 + base64，解密还原', () => {
		setSafeStorageForTest(fake);
		expect(isEncryptionAvailable()).toBe(true);
		const enc = encryptApiKey('sk-秘密 key!@#');
		expect(enc.startsWith('enc:')).toBe(true);
		expect(enc).not.toContain('sk-');
		expect(decryptApiKey(enc)).toBe('sk-秘密 key!@#');
	});

	it('已是 enc: 的值不会二次加密；空串不加密', () => {
		setSafeStorageForTest(fake);
		expect(encryptApiKey('enc:abc')).toBe('enc:abc');
		expect(encryptApiKey('')).toBe('');
	});

	it('isEncryptionAvailable 为 false 的实现 → 明文直存', () => {
		setSafeStorageForTest({ ...fake, isEncryptionAvailable: () => false });
		expect(encryptApiKey('sk-x')).toBe('sk-x');
	});

	it('decryptString 抛错 → null', () => {
		setSafeStorageForTest(fake);
		// enc:Zm9v 是合法 base64（'foo'），但 fake 拒绝非 fake(...) 前缀
		expect(decryptApiKey('enc:Zm9v')).toBeNull();
	});
});

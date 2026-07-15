// SPDX-License-Identifier: GPL-3.0-or-later
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import { promisify } from 'node:util';
import type { SecretStore } from '@vrrelay/application';
import { publishFileAtomically, withFileMutation } from './file-secret-storage.js';

const execFileAsync = promisify(execFile);

const keychainPromptScript = [
  'set input [open /dev/fd/3 r]',
  'gets $input secret',
  'close $input',
  'spawn /usr/bin/security add-generic-password -U -s $env(VRR_SERVICE) -a $env(VRR_ACCOUNT) -w',
  'expect "password data for new item:"',
  'send -- "$secret\\r"',
  'expect "retype password for new item:"',
  'send -- "$secret\\r"',
  'expect eof',
  'catch wait result',
  'exit [lindex $result 3]'
].join('; ');

async function putKeychainSecret(service: string, account: string, value: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // `security -w` deliberately reads from a terminal rather than stdin. Use
    // the system Expect utility to provide that terminal while carrying the
    // actual value over a private inherited pipe. The value is never placed in
    // argv, environment variables, output, or a temporary file.
    const child = spawn('/usr/bin/expect', ['-c', keychainPromptScript], {
      env: { ...process.env, VRR_SERVICE: service, VRR_ACCOUNT: account },
      stdio: ['ignore', 'ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    const errorPipe = child.stderr;
    if (!errorPipe) {
      child.kill();
      reject(new Error('Unable to open the Keychain error pipe'));
      return;
    }
    errorPipe.setEncoding('utf8');
    errorPipe.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`/usr/bin/expect exited with code ${code ?? 'unknown'}: ${stderr.trim()}`)
        );
    });
    const secretPipe = child.stdio[3] as Writable | null;
    if (!secretPipe || typeof secretPipe === 'number') {
      child.kill();
      reject(new Error('Unable to open the private Keychain input pipe'));
      return;
    }
    secretPipe.end(`${value}\n`);
  });
}

interface EncryptedValue {
  iv: string;
  tag: string;
  ciphertext: string;
}

export class MemorySecretStore implements SecretStore {
  readonly #values = new Map<string, string>();

  async put(ref: string, value: string): Promise<void> {
    this.#values.set(ref, value);
  }
  async get(ref: string): Promise<string> {
    const value = this.#values.get(ref);
    if (value === undefined) throw new Error(`Secret not found: ${ref}`);
    return value;
  }
  async delete(ref: string): Promise<void> {
    this.#values.delete(ref);
  }
}

export class EncryptedFileSecretStore implements SecretStore {
  readonly #path: string;
  readonly #key: Buffer;

  constructor(path: string, masterKey: string) {
    if (masterKey.length < 24)
      throw new Error('VRRELAY_MASTER_KEY must contain at least 24 characters');
    this.#path = path;
    this.#key = createHash('sha256').update(masterKey).digest();
  }

  async put(ref: string, value: string): Promise<void> {
    await withFileMutation(this.#path, async () => {
      const values = await this.#read();
      values[ref] = this.#encrypt(value);
      await this.#write(values);
    });
  }

  async get(ref: string): Promise<string> {
    const value = (await this.#read())[ref];
    if (!value) throw new Error(`Secret not found: ${ref}`);
    return this.#decrypt(value);
  }

  async delete(ref: string): Promise<void> {
    await withFileMutation(this.#path, async () => {
      const values = await this.#read();
      delete values[ref];
      await this.#write(values);
    });
  }

  #encrypt(value: string): EncryptedValue {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url')
    };
  }

  #decrypt(value: EncryptedValue): string {
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(value.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  }

  async #read(): Promise<Record<string, EncryptedValue>> {
    try {
      return JSON.parse(await readFile(this.#path, 'utf8')) as Record<string, EncryptedValue>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  async #write(values: Record<string, EncryptedValue>): Promise<void> {
    await publishFileAtomically(this.#path, JSON.stringify(values, null, 2), {
      directoryMode: 0o700,
      fileMode: 0o600
    });
  }
}

export class MacKeychainSecretStore implements SecretStore {
  readonly #service: string;

  constructor(service = 'com.vrrelay.provider-secrets') {
    this.#service = service;
  }

  async put(ref: string, value: string): Promise<void> {
    // macOS explicitly warns that `-w <password>` exposes the password in the
    // process argument vector. A trailing `-w` prompts on stdin instead.
    await putKeychainSecret(this.#service, ref, value);
  }

  async get(ref: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync('/usr/bin/security', [
        'find-generic-password',
        '-s',
        this.#service,
        '-a',
        ref,
        '-w'
      ]);
      return stdout.trimEnd();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('could not be found')) throw new Error(`Secret not found: ${ref}`);
      throw error;
    }
  }

  async delete(ref: string): Promise<void> {
    try {
      await execFileAsync('/usr/bin/security', [
        'delete-generic-password',
        '-s',
        this.#service,
        '-a',
        ref
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('could not be found')) throw error;
    }
  }
}

export class WindowsDpapiSecretStore implements SecretStore {
  constructor(private readonly path: string) {}

  async put(ref: string, value: string): Promise<void> {
    await withFileMutation(this.path, async () => {
      const values = await this.#read();
      values[ref] = await this.#protect(value);
      await this.#write(values);
    });
  }

  async get(ref: string): Promise<string> {
    const value = (await this.#read())[ref];
    if (!value) throw new Error(`Secret not found: ${ref}`);
    return this.#unprotect(value);
  }

  async delete(ref: string): Promise<void> {
    await withFileMutation(this.path, async () => {
      const values = await this.#read();
      delete values[ref];
      await this.#write(values);
    });
  }

  async #protect(value: string): Promise<string> {
    const script = `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($env:VRR_VALUE),$null,[Security.Cryptography.DataProtectionScope]::LocalMachine))`;
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, VRR_VALUE: value } }
    );
    return stdout.trim();
  }

  async #unprotect(value: string): Promise<string> {
    const script = `[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:VRR_VALUE),$null,[Security.Cryptography.DataProtectionScope]::LocalMachine))`;
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, VRR_VALUE: value } }
    );
    return stdout.trimEnd();
  }

  async #read(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  async #write(values: Record<string, string>): Promise<void> {
    const secure = (path: string) =>
      execFileAsync('icacls.exe', [
        path,
        '/inheritance:r',
        '/grant:r',
        '*S-1-5-18:F',
        '*S-1-5-32-544:F'
      ]).then(() => undefined);
    await publishFileAtomically(this.path, JSON.stringify(values, null, 2), {
      secureTemporary: secure,
      secureDestination: secure
    });
  }
}

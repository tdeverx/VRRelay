// SPDX-License-Identifier: GPL-3.0-or-later
import forge from 'node-forge';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { CertificateAuthority, CertificateBundle, SecretStore } from '@vrrelay/application';

interface StoredCa {
  certificatePem: string;
  privateKeyPem: string;
}

export class FileCertificateAuthority implements CertificateAuthority {
  #ca?: Promise<StoredCa>;

  constructor(
    private readonly secrets: SecretStore,
    private readonly reference = 'cluster:certificate-authority'
  ) {}

  async issue(
    commonName: string,
    ttlMs: number,
    dnsNames: readonly string[] = []
  ): Promise<CertificateBundle> {
    const ca = await this.#loadOrCreate();
    const caCertificate = forge.pki.certificateFromPem(ca.certificatePem);
    const caKey = forge.pki.privateKeyFromPem(ca.privateKeyPem);
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const certificate = forge.pki.createCertificate();
    certificate.publicKey = keys.publicKey;
    certificate.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));
    certificate.validity.notBefore = new Date(Date.now() - 60_000);
    certificate.validity.notAfter = new Date(Date.now() + ttlMs);
    certificate.setSubject([
      { name: 'commonName', value: commonName },
      { name: 'organizationName', value: 'VRRelay cluster node' }
    ]);
    certificate.setIssuer(caCertificate.subject.attributes);
    certificate.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', clientAuth: true, serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 6, value: `urn:vrrelay:${commonName}` },
          ...dnsNames.map((value) => (isIP(value) ? { type: 7, ip: value } : { type: 2, value }))
        ]
      }
    ]);
    certificate.sign(caKey, forge.md.sha256.create());
    const der = Buffer.from(
      forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes(),
      'binary'
    );
    return {
      certificatePem: forge.pki.certificateToPem(certificate),
      privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
      caCertificatePem: ca.certificatePem,
      expiresAt: certificate.validity.notAfter.toISOString(),
      serialNumber: certificate.serialNumber,
      fingerprintSha256: createHash('sha256').update(der).digest('hex')
    };
  }

  async caCertificate(): Promise<string> {
    return (await this.#loadOrCreate()).certificatePem;
  }

  async #loadOrCreate(): Promise<StoredCa> {
    this.#ca ??= this.#readOrCreate();
    return this.#ca;
  }

  async #readOrCreate(): Promise<StoredCa> {
    try {
      return JSON.parse(await this.secrets.get(this.reference)) as StoredCa;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('Secret not found:')) throw error;
    }
    const keys = forge.pki.rsa.generateKeyPair(3072);
    const certificate = forge.pki.createCertificate();
    certificate.publicKey = keys.publicKey;
    certificate.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));
    certificate.validity.notBefore = new Date(Date.now() - 60_000);
    certificate.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60_000);
    const subject = [
      { name: 'commonName', value: 'VRRelay private cluster CA' },
      { name: 'organizationName', value: 'VRRelay' }
    ];
    certificate.setSubject(subject);
    certificate.setIssuer(subject);
    certificate.setExtensions([
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true }
    ]);
    certificate.sign(keys.privateKey, forge.md.sha256.create());
    const stored = {
      certificatePem: forge.pki.certificateToPem(certificate),
      privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey)
    };
    await this.secrets.put(this.reference, JSON.stringify(stored));
    return stored;
  }
}

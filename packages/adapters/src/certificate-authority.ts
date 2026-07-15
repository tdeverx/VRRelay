// SPDX-License-Identifier: GPL-3.0-or-later
import forge from 'node-forge';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type {
  CertificateAuthority,
  CertificateBundle,
  SecretStore,
  SignedCertificate
} from '@vrrelay/application';

const MAX_CSR_PEM_BYTES = 16 * 1024;
const MIN_RSA_BITS = 2048;
const MAX_RSA_BITS = 4096;

interface StoredCa {
  certificatePem: string;
  privateKeyPem: string;
}

export interface CertificateSigningRequest {
  privateKeyPem: string;
  csrPem: string;
}

export function createCertificateSigningRequest(commonName: string): CertificateSigningRequest {
  const keys = forge.pki.rsa.generateKeyPair(MIN_RSA_BITS);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([
    { name: 'commonName', value: commonName },
    { name: 'organizationName', value: 'VRRelay cluster node' }
  ]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return {
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    csrPem: forge.pki.certificationRequestToPem(csr)
  };
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
    const keys = forge.pki.rsa.generateKeyPair(MIN_RSA_BITS);
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
    certificate.setExtensions(this.#identityExtensions(commonName, dnsNames));
    certificate.sign(caKey, forge.md.sha256.create());
    return {
      ...this.#signedCertificate(certificate, ca.certificatePem),
      privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey)
    };
  }

  async signCsr(
    commonName: string,
    csrPem: string,
    ttlMs: number,
    dnsNames: readonly string[] = []
  ): Promise<SignedCertificate> {
    if (Buffer.byteLength(csrPem, 'utf8') > MAX_CSR_PEM_BYTES)
      throw new Error(`Certificate signing request exceeds ${MAX_CSR_PEM_BYTES} bytes`);

    let csr: forge.pki.CertificateSigningRequest;
    try {
      csr = forge.pki.certificationRequestFromPem(csrPem, true, true);
    } catch {
      throw new Error('Certificate signing request is not valid PEM');
    }
    if (!csr.publicKey || !('n' in csr.publicKey))
      throw new Error('Certificate signing request must use an RSA public key');
    let signatureValid = false;
    try {
      signatureValid = csr.verify();
    } catch {
      // Treat malformed PKCS#1 signature blocks as an invalid CSR signature.
    }
    if (!signatureValid) throw new Error('Certificate signing request signature is invalid');
    const rsaBits = csr.publicKey.n.bitLength();
    if (rsaBits < MIN_RSA_BITS || rsaBits > MAX_RSA_BITS)
      throw new Error(
        `Certificate signing request RSA key must be ${MIN_RSA_BITS}-${MAX_RSA_BITS} bits`
      );

    const ca = await this.#loadOrCreate();
    const caCertificate = forge.pki.certificateFromPem(ca.certificatePem);
    const caKey = forge.pki.privateKeyFromPem(ca.privateKeyPem);
    const certificate = forge.pki.createCertificate();
    certificate.publicKey = csr.publicKey;
    certificate.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));
    certificate.validity.notBefore = new Date(Date.now() - 60_000);
    certificate.validity.notAfter = new Date(Date.now() + ttlMs);
    certificate.setSubject([
      { name: 'commonName', value: commonName },
      { name: 'organizationName', value: 'VRRelay cluster node' }
    ]);
    certificate.setIssuer(caCertificate.subject.attributes);
    certificate.setExtensions(this.#identityExtensions(commonName, dnsNames));
    certificate.sign(caKey, forge.md.sha256.create());

    return this.#signedCertificate(certificate, ca.certificatePem);
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

  #identityExtensions(commonName: string, dnsNames: readonly string[]) {
    return [
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
    ];
  }

  #signedCertificate(
    certificate: forge.pki.Certificate,
    caCertificatePem: string
  ): SignedCertificate {
    const der = Buffer.from(
      forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes(),
      'binary'
    );
    return {
      certificatePem: forge.pki.certificateToPem(certificate),
      caCertificatePem,
      expiresAt: certificate.validity.notAfter.toISOString(),
      serialNumber: certificate.serialNumber,
      fingerprintSha256: createHash('sha256').update(der).digest('hex')
    };
  }
}

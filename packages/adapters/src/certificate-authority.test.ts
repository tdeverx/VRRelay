// SPDX-License-Identifier: GPL-3.0-or-later
import forge from 'node-forge';
import { beforeAll, describe, expect, it } from 'vitest';
import { MemorySecretStore } from './secret-stores.js';
import {
  createCertificateSigningRequest,
  FileCertificateAuthority
} from './certificate-authority.js';

describe('file certificate authority', () => {
  let request: ReturnType<typeof createCertificateSigningRequest>;
  let certificates: FileCertificateAuthority;

  beforeAll(() => {
    request = createCertificateSigningRequest('bootstrap-node');
    certificates = new FileCertificateAuthority(new MemorySecretStore());
  });

  it('creates a signed RSA-2048 CSR whose private key remains local', () => {
    const csr = forge.pki.certificationRequestFromPem(request.csrPem, true, true);
    const privateKey = forge.pki.privateKeyFromPem(request.privateKeyPem);

    expect(csr.verify()).toBe(true);
    expect(csr.publicKey && 'n' in csr.publicKey ? csr.publicKey.n.bitLength() : 0).toBe(2048);
    expect(csr.publicKey && 'n' in csr.publicKey ? csr.publicKey.n.toString(16) : '').toBe(
      privateKey.n.toString(16)
    );
  });

  it('signs a CSR public key without returning private material', async () => {
    const signed = await certificates.signCsr('node:certificate-test', request.csrPem, 60_000, [
      'worker.example.test',
      '127.0.0.1'
    ]);
    const csr = forge.pki.certificationRequestFromPem(request.csrPem);
    const certificate = forge.pki.certificateFromPem(signed.certificatePem);
    const caCertificate = forge.pki.certificateFromPem(signed.caCertificatePem);
    const subjectAltName = certificate.getExtension('subjectAltName');

    expect(signed).not.toHaveProperty('privateKeyPem');
    expect(certificate.subject.getField('CN').value).toBe('node:certificate-test');
    expect(
      certificate.publicKey && 'n' in certificate.publicKey ? certificate.publicKey.n : null
    ).toEqual(csr.publicKey && 'n' in csr.publicKey ? csr.publicKey.n : null);
    expect(
      forge.pki.verifyCertificateChain(forge.pki.createCaStore([caCertificate]), [certificate])
    ).toBe(true);
    expect(subjectAltName && 'altNames' in subjectAltName ? subjectAltName.altNames : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 6, value: 'urn:vrrelay:node:certificate-test' }),
        expect.objectContaining({ type: 2, value: 'worker.example.test' }),
        expect.objectContaining({ type: 7, ip: '127.0.0.1' })
      ])
    );
  });

  it('keeps controller server identity issuance separate from CSR signing', async () => {
    const controller = await certificates.issue('controller', 60_000, ['controller.example.test']);

    expect(controller.privateKeyPem).toContain('PRIVATE KEY');
    expect(controller.certificatePem).toContain('CERTIFICATE');
  });

  it('rejects malformed, oversized, and incorrectly signed CSRs', async () => {
    await expect(certificates.signCsr('node:test', 'not a CSR', 60_000)).rejects.toThrow(
      'not valid PEM'
    );
    await expect(certificates.signCsr('node:test', 'é'.repeat(8_193), 60_000)).rejects.toThrow(
      'exceeds 16384 bytes'
    );

    const invalid = forge.pki.certificationRequestFromPem(request.csrPem);
    invalid.signature = `${invalid.signature.slice(0, -1)}${
      invalid.signature.endsWith('\x00') ? '\x01' : '\x00'
    }`;
    const invalidPem = forge.pki.certificationRequestToPem(invalid);
    await expect(certificates.signCsr('node:test', invalidPem, 60_000)).rejects.toThrow(
      'signature is invalid'
    );
  });

  it('rejects RSA keys outside the 2048-4096 bit policy', async () => {
    const keys = forge.pki.rsa.generateKeyPair(1024);
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = keys.publicKey;
    csr.setSubject([{ name: 'commonName', value: 'weak-node' }]);
    csr.sign(keys.privateKey, forge.md.sha256.create());

    await expect(
      certificates.signCsr('node:weak', forge.pki.certificationRequestToPem(csr), 60_000)
    ).rejects.toThrow('RSA key must be 2048-4096 bits');
  });
});

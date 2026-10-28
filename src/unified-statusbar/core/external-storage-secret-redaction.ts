import { isRecord } from './type-guards';

const ALWAYS_SECRET_FIELDS = new Set([
  'apikey', 'customapikey', 'accesstoken', 'refreshtoken', 'authorization',
  'password', 'clientsecret', 'customheaders', 'bodyparams',
]);

function looksLikeCredentialContainer(value: Record<string, unknown>, path: readonly string[]): boolean {
  const context = path.join('.').toLowerCase();
  if (/(?:api|preset|secret|credential|auth|header|request)/.test(context)) return true;
  return ['url', 'model', 'source', 'secretId', 'customHeaders', 'bodyParams']
    .some(field => Object.prototype.hasOwnProperty.call(value, field));
}

/**
 * Clone a storage/export payload while removing plaintext credentials.
 * `secretId` references and ordinary labels/IDs are deliberately retained.
 */
export function redactExternalStorageSecrets(value: unknown): unknown {
  const visit = (input: unknown, path: string[]): unknown => {
    if (Array.isArray(input)) return input.map((item, index) => visit(item, path.concat(String(index))));
    if (!isRecord(input)) return input;
    const output: Record<string, unknown> = {};
    for (const [field, child] of Object.entries(input)) {
      const normalized = field.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (normalized === 'secretid') {
        output[field] = child;
        continue;
      }
      if (ALWAYS_SECRET_FIELDS.has(normalized)
        || normalized.endsWith('apikey')
        || normalized.endsWith('presetkeys')
        || normalized.endsWith('credentials')
        || (normalized === 'key' && looksLikeCredentialContainer(input, path))) {
        continue;
      }
      output[field] = visit(child, path.concat(field));
    }
    return output;
  };
  return visit(value, []);
}

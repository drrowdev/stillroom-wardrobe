export type ObjectDeletion = 'removed' | 'missing';
export type DeleteReply = { status: number; ok: boolean; data: unknown };
export type DeleteRequest = (route: string, options: { method: 'DELETE' }) => Promise<DeleteReply>;

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const pathPattern = new RegExp(`^(${uuid})/${uuid}/${uuid}/(?:main|thumb)\\.jpg$`);
const unavailable = () => new Error('error.unavailable');

export function wardrobeDeleteRoute(ownerId: string, path: string): string {
  if (typeof ownerId !== 'string' || typeof path !== 'string') throw unavailable();
  const match = pathPattern.exec(path);
  if (!match || match[1] !== ownerId) throw unavailable();
  return `/storage/v1/object/wardrobe/${path}`;
}

function exact(data: unknown, expected: Record<string, string>): boolean {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return false;
  const keys = Reflect.ownKeys(data);
  return keys.length === Object.keys(expected).length && keys.every((key) =>
    typeof key === 'string' && Object.hasOwn(expected, key)
    && Object.getOwnPropertyDescriptor(data, key)?.value === expected[key]);
}

export function classifyObjectDeletion(reply: DeleteReply): ObjectDeletion {
  if (reply.ok === true && reply.status === 200 && exact(reply.data, { message: 'Successfully deleted' })) return 'removed';
  if (reply.ok === false && reply.status === 400 && exact(reply.data, {
    statusCode: '404', code: 'NoSuchKey', error: 'not_found', message: 'Object not found',
  })) return 'missing';
  if (reply.ok === false && reply.status === 400 && exact(reply.data, {
    statusCode: '403', code: 'AccessDenied', error: 'Unauthorized', message: 'Access denied',
  })) throw new Error('error.notAvailable');
  throw unavailable();
}

export async function deleteWardrobeObject(request: DeleteRequest, ownerId: string, path: string): Promise<ObjectDeletion> {
  const route = wardrobeDeleteRoute(ownerId, path);
  return classifyObjectDeletion(await request(route, { method: 'DELETE' }));
}

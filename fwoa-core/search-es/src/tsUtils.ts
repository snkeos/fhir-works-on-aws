// eslint-disable-next-line import/prefer-default-export
export function isPresent<T>(t: T | undefined | null | void): t is T {
  return t !== undefined && t !== null;
}

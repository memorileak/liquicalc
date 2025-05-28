function roundWithFunction(
  n: number,
  f: number,
  roundFn: (x: number) => number,
): number {
  if (!Number.isInteger(f) || f < 0) {
    f = Math.floor(Math.abs(f));
  }
  if (!Number.isFinite(n)) {
    return n;
  }
  const str = n.toString();
  if (!str.includes(".")) {
    return n;
  }
  const multiplier = Math.pow(10, f);
  return roundFn(n * multiplier) / multiplier;
}

export function round(n: number, f: number): number {
  return roundWithFunction(n, f, Math.round);
}

export function roundUp(n: number, f: number): number {
  return roundWithFunction(n, f, Math.ceil);
}

export function roundDown(n: number, f: number): number {
  return roundWithFunction(n, f, Math.floor);
}

export function addPercentage(n: number, p: number): number {
  if (!Number.isFinite(n) || !Number.isFinite(p)) {
    return NaN;
  }
  return n + (n * p) / 100;
}

export function subtractPercentage(n: number, p: number): number {
  if (!Number.isFinite(n) || !Number.isFinite(p)) {
    return NaN;
  }
  return n - (n * p) / 100;
}

export function isApprox(a: number, b: number, p: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(p)) {
    return false;
  }
  const absA = Math.abs(a);
  const absB = Math.abs(b);
  const larger = Math.max(absA, absB);
  const smaller = Math.min(absA, absB);
  const lowerBound = subtractPercentage(larger, p);
  const upperBound = addPercentage(larger, p);
  return smaller >= lowerBound && smaller <= upperBound;
}

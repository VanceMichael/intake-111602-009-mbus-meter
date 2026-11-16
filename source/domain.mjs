export function dispatch({ url, phase }) {
  if (url.pathname === '/meter/1/identity') return { json: { primaryAddress: 1,
    secondaryAddress: phase ? '87654321-2c2d-1-4' : '12345678-2c2d-1-4', accessNumber: 5 } };
  return null;
}

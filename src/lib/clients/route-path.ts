export interface RoutePathResponse {
  routes: any[];
  queryParamsArr: string[];
  airportList?: {
    O?: string[];
    A?: string[];
    B?: string[];
    D?: string[];
  };
}

export async function fetchRoutePaths(baseUrl: string, params: { origin: string; destination: string; maxStop: number; binbin?: boolean }): Promise<RoutePathResponse> {
  const url = `${baseUrl}/api/create-full-route-path`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    throw new Error('Failed to fetch route paths');
  }
  return res.json();
}



import { NextRequest } from 'next/server';
import { RouteOrchestratorService } from '@/lib/route-path/route-orchestrator';

export async function POST(req: NextRequest) {
  return await RouteOrchestratorService.createFullRoutePaths(req);
}
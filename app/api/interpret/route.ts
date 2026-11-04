import { analyze } from '@/lib/ai/analysis';

export function POST(request: Request) {
  return analyze(request, 'interpret');
}

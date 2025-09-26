export interface FilterParams {
  page: number;
  pageSize: number;
  sortBy?: string;
  search?: string;
  filters?: Record<string, unknown>;
}

export interface ErrorResponseBody {
  error: string;
  details?: unknown;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}



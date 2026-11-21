// Interfaces mirroring docs/API_CONTRACT.md. Optional fields keep the UI
// tolerant of partial backend implementations during development.

export interface AuthStatus {
  setupRequired: boolean;
  version: string;
  hostname: string;
  channel: string;
}

export interface AuthResult {
  token: string;
  user: User;
  expiresAt?: string;
}

export interface ApiErrorInfo {
  code: string;
  message: string;
  details?: any;
}

export interface Host {
  hostname?: string;
  version?: string;
  kernel?: string;
  arch?: string;
  uptime?: number | string;
  cpu?: string;
  cores?: number;
  memoryTotal?: number;
  memoryUsed?: number;
  temperature?: number;
  [key: string]: any;
}

export interface MetricValue {
  value?: number;
  percent?: number;
  usage?: number;
  used?: number;
  total?: number;
  rx?: number;
  tx?: number;
  read?: number;
  write?: number;
  temp?: number;
  cores?: number[];
  [key: string]: any;
}

export interface Metrics {
  cpu?: number | MetricValue;
  ram?: number | MetricValue;
  disk?: number | MetricValue;
  network?: number | MetricValue;
  time?: number | string;
  [key: string]: any;
}

export interface MetricsHistory {
  cpu: number[];
  ram: number[];
  network: number[];
}

export interface VM {
  id: string;
  name: string;
  type: 'kvm' | 'lxc' | string;
  status?: string;
  state?: string;
  cpu?: number;
  memory?: number;
  disk?: number;
  ip?: string;
  node?: string;
  iso?: string;
  template?: string;
  uptime?: number;
  tags?: string[];
  description?: string;
  [key: string]: any;
}

export type Container = VM;

export interface Snapshot {
  id?: string;
  name: string;
  time?: string;
  created?: string;
  [key: string]: any;
}

export interface VncInfo {
  url: string;
  port?: number;
  websocket?: string;
  [key: string]: any;
}

export interface PciDevice {
  id: string;
  vendor?: string;
  device?: string;
  iommuGroup?: number | string;
  usable?: boolean;
  [key: string]: any;
}

export interface Bridge {
  id?: string;
  name: string;
  ports?: string[];
  vlanAware?: boolean;
  tag?: number;
  [key: string]: any;
}

export interface VmTemplate {
  id?: string;
  name: string;
  cpu?: number;
  memory?: number;
  disk?: number;
  [key: string]: any;
}

export interface FirewallRule {
  id?: string;
  direction?: 'in' | 'out' | string;
  action?: 'accept' | 'drop' | 'reject' | string;
  protocol?: string;
  port?: string;
  source?: string;
  enabled?: boolean;
  [key: string]: any;
}

export interface Disk {
  id: string;
  model?: string;
  size?: number;
  type?: string;
  temp?: number;
  smart?: string | boolean;
  role?: string;
  state?: string;
  serial?: string;
  [key: string]: any;
}

export interface ArrayStatus {
  status?: string;
  state?: string;
  parity?: any[];
  data?: any[];
  used?: number;
  total?: number;
  syncProgress?: number;
  errors?: string[];
  [key: string]: any;
}

export interface Dataset {
  name: string;
  pool?: string;
  compression?: string;
  quota?: number | string;
  used?: number;
  [key: string]: any;
}

export interface Share {
  id: string;
  name: string;
  path: string;
  disk?: string;
  protocol?: 'smb' | 'nfs' | 'ftp' | string;
  users?: string[];
  permissions?: string | Record<string, string>;
  recycle?: boolean;
  readOnly?: boolean;
  [key: string]: any;
}

export interface User {
  id?: string;
  username?: string;
  name?: string;
  role?: string;
  roles?: string[];
  email?: string;
  permissions?: string[];
  enabled?: boolean;
  [key: string]: any;
}

export interface Group {
  id?: string;
  name: string;
  members?: string[];
  permissions?: string[];
  [key: string]: any;
}

export interface CatalogApp {
  id: string;
  name: string;
  category?: string;
  version?: string;
  description?: string;
  icon?: string;
  trusted?: boolean;
  installed?: boolean;
  updateAvailable?: boolean;
  [key: string]: any;
}

export interface App {
  id: string;
  name?: string;
  appId?: string;
  status?: string;
  state?: string;
  version?: string;
  image?: string;
  ports?: any[] | Record<string, any>;
  env?: any;
  volumes?: any[];
  limits?: Record<string, any>;
  [key: string]: any;
}

export interface Repo {
  id?: string;
  url: string;
  trusted?: boolean;
  status?: string;
  [key: string]: any;
}

export interface Alert {
  id?: string;
  type?: string;
  target?: string;
  threshold?: number;
  enabled?: boolean;
  level?: string;
  message?: string;
  time?: string;
  [key: string]: any;
}

export interface Event {
  id?: string;
  level?: string;
  message?: string;
  time?: string;
  actor?: string;
  action?: string;
  resource?: string;
  sourceIp?: string;
  [key: string]: any;
}

export interface Backup {
  id?: string;
  name?: string;
  target?: string;
  schedule?: string;
  retention?: number;
  enabled?: boolean;
  lastRun?: string;
  status?: string;
  [key: string]: any;
}

export interface Plugin {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  signed?: boolean;
  enabled?: boolean;
  installed?: boolean;
  [key: string]: any;
}

export interface ClusterNode {
  id: string;
  name?: string;
  address?: string;
  role?: string;
  status?: string;
  state?: string;
  latency?: number;
  [key: string]: any;
}

export interface Settings {
  hostname?: string;
  timezone?: string;
  language?: string;
  theme?: string;
  kiosk?: boolean;
  interfaces?: any[];
  bridges?: any[];
  dns?: string[];
  gateway?: string;
  proxy?: string;
  firewall?: any;
  array?: any;
  paritySchedule?: string;
  smart?: any;
  trim?: boolean;
  roles?: any[];
  twoFactorPolicy?: string;
  sshKeys?: string[];
  channel?: string;
  kernelParams?: string;
  [key: string]: any;
}

export interface UpdateInfo {
  current?: string;
  latest?: string;
  updateAvailable?: boolean;
  releaseUrl?: string;
  publishedAt?: string;
  state?: string;
  progress?: number;
  message?: string;
  jobId?: string;
  [key: string]: any;
}

export interface DashboardData {
  host: Host;
  metrics: Metrics;
  counts: { vms?: number; containers?: number; shares?: number; apps?: number; [key: string]: any };
  array: ArrayStatus;
  events: Event[];
  alerts: Alert[];
}

export interface ApiToken {
  id: string;
  name?: string;
  token?: string;
  created?: string;
  lastUsed?: string;
  [key: string]: any;
}

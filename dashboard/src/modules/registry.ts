import type { ComponentType } from 'react';
import { StatusPage } from './status/StatusPage';
import { ConfigPage } from './config/ConfigPage';
import { RoutinesPage } from './routines/RoutinesPage';
import { ActivityPage } from './activity/ActivityPage';
import { PrivacyPage } from './privacy/PrivacyPage';
import { LogsPage } from './logs/LogsPage';

export interface DashboardModule {
  id: string;
  label: string;
  icon: string;
  route: string;
  component: ComponentType;
}

export const modules: DashboardModule[] = [
  { id: 'status',   label: 'Status',   icon: '◉', route: '/',          component: StatusPage },
  { id: 'config',   label: 'Config',   icon: '⚙', route: '/config',    component: ConfigPage },
  { id: 'routines', label: 'Routines', icon: '↻', route: '/routines',  component: RoutinesPage },
  { id: 'activity', label: 'Activity', icon: '◫', route: '/activity',  component: ActivityPage },
  { id: 'privacy',  label: 'Privacy',  icon: '⊘', route: '/privacy',   component: PrivacyPage },
  { id: 'logs',     label: 'Logs',     icon: '▤', route: '/logs',      component: LogsPage },
];

/** Side-effect entry: install web mode globals as early as possible (imported first by main.tsx). */
import { installWebHost } from './install';

installWebHost();

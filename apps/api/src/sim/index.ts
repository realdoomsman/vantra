// Demo colony: seeds DEMO_AGENTS agents with the mock provider + memory chain, fast-forwards the
// FastClock through DEMO_DAYS of real step-loop runs, then releases the clock to real time. SPEC §8.18.
// The launchpad's coins are seeded alongside it (sim/launches.ts).
export { runDemo, PENDING_SALES, TICK_HOURS } from './demo.js';
export { colonyCast, type ColonyMember } from './colony.js';
export { DEMO_LAUNCHES, LAUNCH_WINDOW_DAYS, launchSeeder, type DemoLaunch, type LaunchSeeder } from './launches.js';

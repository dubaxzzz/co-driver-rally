/**
 * Chassis + suspension set-up, shared by the game and tests/rollover.test.ts
 * (run `npm run test:rollover` after changing anything here).
 *
 * Lowered gravel set-up: short, fairly stiff springs, a low centre of mass
 * and a roll stabiliser, so hard cornering slides the car instead of
 * tipping it over.
 */

export const SUSPENSION = {
  restLength: 0.3,
  maxTravel: 0.22,
  stiffness: 26,
  compression: 2.3,
  relaxation: 3.1,
  maxForce: 70000,
  antiRollFront: 24000, // N per metre of left/right compression difference
  antiRollRear: 16000,
};

export const CHASSIS = {
  /** Centre of mass height relative to the body origin (lower = harder to roll). */
  comY: -0.36,
  /** Wheel mount height relative to the body origin. */
  wheelY: -0.12,
  angularDamping: 0.6,
  /** Torque (N·m per unit of sideways lean) pulling the car back upright. */
  rollStabiliser: 7000,
  /** Damping of roll rate (N·m per rad/s). */
  rollDamping: 2000,
};

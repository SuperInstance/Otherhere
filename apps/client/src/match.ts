import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  RingGeometry,
  SphereGeometry,
  type Scene,
} from 'three/webgpu';
import {
  CTF_V0,
  visibleTo,
  type MatchEvent,
  type MatchState,
  type PlayerPos,
  type Team,
} from '@otherhere/core';
import type { PeerState } from './net';

export const TEAM_COLOURS = ['#c4553a', '#3a6fc4'] as const;
export const TEAM_NAMES = ['Red', 'Blue'] as const;

const mat = (colour: string) =>
  new MeshStandardNodeMaterial({ color: colour, roughness: 0.8, metalness: 0 });
const MATS = TEAM_COLOURS.map(mat);
const POLE = mat('#3b3f45');

function pawn(team: Team): Group {
  const g = new Group();
  const body = new Mesh(new CylinderGeometry(0.32, 0.4, 1.2, 10), MATS[team]);
  body.position.y = 0.6;
  const head = new Mesh(new SphereGeometry(0.28, 12, 8), MATS[team]);
  head.position.y = 1.5;
  const nose = new Mesh(new ConeGeometry(0.1, 0.3, 6), POLE);
  nose.rotation.x = -Math.PI / 2;
  nose.position.set(0, 1.5, -0.32);
  g.add(body, head, nose);
  return g;
}

function flagMesh(team: Team): Group {
  const g = new Group();
  const pole = new Mesh(new CylinderGeometry(0.05, 0.05, 3.2, 6), POLE);
  pole.position.y = 1.6;
  const cloth = new Mesh(new BoxGeometry(1.1, 0.7, 0.04), MATS[team]);
  cloth.position.set(0.58, 2.8, 0);
  g.add(pole, cloth);
  return g;
}

function baseMesh(team: Team): Mesh {
  const ring = new Mesh(
    new RingGeometry(CTF_V0.captureRadiusM - 0.8, CTF_V0.captureRadiusM, 48),
    MATS[team],
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.12;
  return ring;
}

/**
 * Draws a match: other players (through team fog), both bases, both flags.
 * Positions are in the session's world frame, the same one the World renders in.
 */
export class MatchView {
  private root = new Group();
  private pawns = new Map<string, Group>();
  private flags: [Group, Group] = [flagMesh(0), flagMesh(1)];
  private bases: [Mesh, Mesh] = [baseMesh(0), baseMesh(1)];
  match: MatchState | null = null;
  visibleIds = new Set<string>();

  constructor(scene: Scene) {
    this.root.add(...this.flags, ...this.bases);
    scene.add(this.root);
  }

  setMatch(m: MatchState) {
    this.match = m;
    m.bases.forEach((b, i) => this.bases[i as Team].position.set(b.x, 0.12, b.z));
  }

  update(me: PlayerPos & { yaw: number }, peers: Map<string, PeerState>, dt: number) {
    const m = this.match;
    if (!m) return;
    const everyone: PlayerPos[] = [
      me,
      ...[...peers.values()]
        .filter((p) => p.heardAt)
        .map((p) => ({ id: p.info.id, team: p.info.team, x: p.x, z: p.z })),
    ];
    this.visibleIds.clear();

    for (const [id, g] of this.pawns) {
      if (!peers.has(id)) {
        this.root.remove(g);
        this.pawns.delete(id);
      }
    }
    for (const p of peers.values()) {
      let g = this.pawns.get(p.info.id);
      if (!g || g.userData.team !== p.info.team) {
        if (g) this.root.remove(g);
        g = pawn(p.info.team);
        g.userData.team = p.info.team;
        g.position.set(p.x, 0, p.z);
        this.pawns.set(p.info.id, g);
        this.root.add(g);
      }
      // Ease toward the latest reported pose.
      const k = 1 - Math.exp(-dt * 12);
      g.position.x += (p.x - g.position.x) * k;
      g.position.z += (p.z - g.position.z) * k;
      g.rotation.y = p.yaw;
      const shown =
        p.heardAt > 0 &&
        visibleTo(
          me.team,
          { id: p.info.id, team: p.info.team, x: p.x, z: p.z },
          everyone,
          CTF_V0.ruleset.fog,
        );
      g.visible = shown;
      if (shown) this.visibleIds.add(p.info.id);
    }

    m.flags.forEach((f, i) => {
      const g = this.flags[i as Team];
      const carrier = f.carrier === me.id ? me : f.carrier ? peers.get(f.carrier) : null;
      // A carried flag rides above its carrier (and hides with them in the fog).
      if (carrier) g.position.set(carrier.x, f.carrier === me.id ? 0.4 : 1.2, carrier.z);
      else g.position.set(f.x, 0, f.z);
      g.visible = !f.carrier || f.carrier === me.id || this.visibleIds.has(f.carrier);
    });
  }
}

/** Human-readable lines for match events. */
export function describeEvent(e: MatchEvent, names: (id: string) => string): string {
  switch (e.kind) {
    case 'pickup':
      return `${names(e.player)} grabbed the ${TEAM_NAMES[e.flag]} flag`;
    case 'capture':
      return `${names(e.player)} captured the ${TEAM_NAMES[e.flag]} flag. ${TEAM_NAMES[e.team]} scores!`;
    case 'tag':
      return `${names(e.by)} tagged ${names(e.player)}`;
    case 'return':
      return `The ${TEAM_NAMES[e.flag]} flag went home`;
    case 'end':
      return e.winner === null ? 'Time! It is a draw.' : `${TEAM_NAMES[e.winner]} wins!`;
  }
}

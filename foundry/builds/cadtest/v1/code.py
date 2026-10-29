# ships wheel smoke test (mm)
from build123d import *
rim = Pos(0, 0, 0) * Cylinder(radius=210, height=40)
tire = Pos(0, 0, 0) * Cylinder(radius=235, height=34)
hub = Pos(0, 0, 0) * Cylinder(radius=55, height=90)
wheel = tire - Pos(0, 0, 0) * Cylinder(radius=200, height=60)
wheel += rim
wheel += hub
for i in range(8):
    spoke = Rot(0, 0, i * 45) * Pos(120, 0, 0) * Box(150, 26, 30)
    wheel += spoke
result = wheel

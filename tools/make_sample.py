#!/usr/bin/env python3
"""Generate samples/twisted-vase.gcode: a demo print for printsim.

A twisted, wavy rounded-hexagon vase for the Prusa MINI (180x180 bed),
with PrusaSlicer-style structure: header metadata, start G-code with
heating/homing/mesh leveling, purge line, ;TYPE: / ;WIDTH: comments,
M73 progress markers and an estimated print time.
Not meant to be printed as-is; it's a realistic file for the simulator.
"""
import math
import os

BED_C = 90.0
LAYER_H = 0.2
FIRST_H = 0.2
HEIGHT = 44.0
BOTTOM_LAYERS = 4
WIDTH = 0.45
FIL_AREA = math.pi * (1.75 / 2) ** 2
PTS = 180

def radius(theta, z):
    # rounded hexagon, radius breathing with height, twisting upwards
    base = 22 + 5 * math.sin(z / HEIGHT * math.pi * 1.2) - 3 * (z / HEIGHT)
    tw = theta + z / HEIGHT * math.pi * 0.55
    return base * (1 + 0.075 * math.cos(6 * tw))

def ring(z, inset):
    pts = []
    for i in range(PTS):
        t = 2 * math.pi * i / PTS
        r = radius(t, z) - inset
        pts.append((BED_C + r * math.cos(t), BED_C + r * math.sin(t)))
    return pts

out = []
time_s = 0.0
pos = [0.0, 0.0, 0.0]
feed = 0.0

def emit(s):
    out.append(s)

def move(x=None, y=None, z=None, e=None, f=None):
    global time_s, feed
    parts = ['G1']
    nx = pos[0] if x is None else x
    ny = pos[1] if y is None else y
    nz = pos[2] if z is None else z
    if x is not None: parts.append(f'X{x:.3f}')
    if y is not None: parts.append(f'Y{y:.3f}')
    if z is not None: parts.append(f'Z{z:.3f}')
    if e is not None: parts.append(f'E{e:.5f}')
    if f is not None:
        parts.append(f'F{f:.0f}')
        feed = f / 60
    d = math.dist(pos, (nx, ny, nz))
    if d == 0 and e is not None:
        d = abs(e)
    if feed > 0:
        time_s += d / min(feed, 180) + 0.0015
    pos[:] = [nx, ny, nz]
    emit(' '.join(parts))

def extrude_path(pts, speed, h, close=True):
    move(f=speed * 60)
    seq = pts + ([pts[0]] if close else [])
    for (x, y) in seq[1:]:
        d = math.dist(pos[:2], (x, y))
        e = d * WIDTH * h / FIL_AREA
        move(x=x, y=y, e=e)

def travel(x, y, z=None):
    move(e=-0.7, f=2100)
    if z is not None:
        move(z=z + 0.2, f=720)
    move(x=x, y=y, f=10800)
    if z is not None:
        move(z=z, f=720)
    move(e=0.7, f=1500)

body = []
out = body

# --- layers
layers = []
z = FIRST_H
n = 0
while z <= HEIGHT + 1e-6:
    layers.append((n, round(z, 3)))
    z += LAYER_H
    n += 1

for n, z in layers:
    h = FIRST_H if n == 0 else LAYER_H
    if n == 1:
        emit('M106 S255')  # part fan on from layer 2
    emit(';LAYER_CHANGE')
    emit(f';Z:{z:.1f}' if abs(z * 10 - round(z * 10)) < 1e-6 else f';Z:{z}')
    emit(f';HEIGHT:{h}')
    first = n == 0
    # skirt on first layer
    if first:
        sk = ring(z, -6)
        travel(*sk[0], z=z)
        emit(';TYPE:Skirt/Brim')
        emit(f';WIDTH:{WIDTH}')
        extrude_path(sk, 25, h)
    outer = ring(z, 0)
    inner = ring(z, WIDTH * 0.95)
    s_ext = 22 if first else 32
    s_per = 25 if first else 45
    travel(*inner[0], z=z)
    emit(';TYPE:Perimeter')
    emit(f';WIDTH:{WIDTH}')
    extrude_path(inner, s_per, h)
    travel(*outer[0])
    emit(';TYPE:External perimeter')
    extrude_path(outer, s_ext, h)
    if n < BOTTOM_LAYERS:
        # rectilinear solid bottom, alternating direction
        emit(';TYPE:Solid infill' if n else ';TYPE:Solid infill')
        emit(f';WIDTH:{WIDTH + 0.05:.2f}')
        angle = math.pi / 4 if n % 2 == 0 else -math.pi / 4
        ca, sa = math.cos(angle), math.sin(angle)
        limit = [(x - BED_C, y - BED_C) for (x, y) in ring(z, WIDTH * 1.9)]
        r_in = min(math.hypot(x, y) for x, y in limit)
        span = int(r_in / WIDTH)
        fwd = True
        started = False
        for k in range(-span + 1, span):
            off = k * WIDTH
            half = math.sqrt(max(r_in ** 2 - off ** 2, 0)) * 0.98
            if half < 1:
                continue
            a = (-half, off) if fwd else (half, off)
            b = (half, off) if fwd else (-half, off)
            ax, ay = BED_C + a[0] * ca - a[1] * sa, BED_C + a[0] * sa + a[1] * ca
            bx, by = BED_C + b[0] * ca - b[1] * sa, BED_C + b[0] * sa + b[1] * ca
            if not started:
                travel(ax, ay)
                move(f=(30 if first else 70) * 60)
                started = True
            else:
                d = math.dist(pos[:2], (ax, ay))
                move(x=ax, y=ay, e=d * WIDTH * h / FIL_AREA)
            d = math.dist(pos[:2], (bx, by))
            move(x=bx, y=by, e=d * WIDTH * h / FIL_AREA)
            fwd = not fwd

total = time_s
e_total = sum(float(m) for line in body for m in __import__('re').findall(r'E(-?\d*\.?\d+)', line) if float(m) > 0)
grams = e_total * FIL_AREA / 1000 * 1.24

# --- insert M73 markers by accumulated time (like PrusaSlicer does)
final = []
t = 0.0
last_p = -1
pos = [0.0, 0.0, 0.0]; feed = 0.0; time_s = 0.0
# replay to time each line
import re
num = re.compile(r'([XYZEF])(-?\d*\.?\d+)')
cur = [0.0, 0.0, 0.0]
f = 0.0
for line in body:
    if line.startswith('G1'):
        vals = dict((k, float(v)) for k, v in num.findall(line))
        if 'F' in vals:
            f = vals['F'] / 60
        nxt = [vals.get('X', cur[0]), vals.get('Y', cur[1]), vals.get('Z', cur[2])]
        d = math.dist(cur, nxt)
        if d == 0 and 'E' in vals:
            d = abs(vals['E'])
        if f > 0:
            t += d / min(f, 180) + 0.0015
        cur = nxt
    p = int(t / total * 100)
    if p != last_p and p < 100:
        final.append(f'M73 P{p} R{math.ceil((total - t) / 60)}')
        last_p = p
    final.append(line)

def hms(s):
    s = int(round(s))
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    return (f'{h}h ' if h else '') + f'{m}m {sec}s'

header = f"""; generated by printsim tools/make_sample.py (PrusaSlicer-style demo file)

; printer_model = MINI
; filament_type = PLA
; nozzle_diameter = 0.4
; bed_temperature = 60
; temperature = 215
; layer_height = {LAYER_H}
; max_layer_z = {layers[-1][1]}
; filament_colour = #B9A3F5
; estimated printing time (normal mode) = {hms(total)}
; filament used [g] = {grams:.2f}

M73 P0 R{math.ceil(total / 60)}
M201 X2500 Y2500 Z400 E5000
M203 X180 Y180 Z12 E80
M204 P1250 R1250 T1250
M205 X8.00 Y8.00 Z2.00 E10.00
;TYPE:Custom
G90 ; use absolute coordinates
M83 ; extruder relative mode
M104 S170 ; set extruder temp for bed leveling
M140 S60 ; set bed temp
M109 R170 ; wait for bed leveling temp
M190 S60 ; wait for bed temp
G28 ; home all without mesh bed level
G29 ; mesh bed leveling
M104 S215 ; set extruder temp
G92 E0
G1 Z0.2 F720
G1 Y-3 F1000 ; go outside print area
M109 S215 ; wait for extruder temp
G1 X60 E9 F1000 ; intro line
G1 X100 E12.5 F1000 ; intro line
G92 E0
M221 S95
M900 K0.2
M107
"""

footer = f"""M73 P100 R0
;TYPE:Custom
G1 E-1 F2100
G1 Z{layers[-1][1] + 10:.1f} F720 ; move print head up
G1 X178 Y178 F4200 ; park print head
M104 S0 ; turn off temperature
M140 S0 ; turn off heatbed
M107 ; turn off fan
M84 ; disable motors
; filament used [g] = {grams:.2f}
"""

os.makedirs(os.path.join(os.path.dirname(__file__), '..', 'samples'), exist_ok=True)
path = os.path.join(os.path.dirname(__file__), '..', 'samples', 'twisted-vase.gcode')
with open(path, 'w') as fh:
    fh.write(header)
    fh.write('\n'.join(final))
    fh.write('\n')
    fh.write(footer)
print(path, len(final), 'lines, est', hms(total), f'{os.path.getsize(path)/1e6:.1f} MB')

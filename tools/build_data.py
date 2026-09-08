#!/usr/bin/env python3
import csv
import gzip
import math
import os
import struct
import sys
import zlib
from collections import defaultdict

MAX_NODES = 1024
MAX_VIZ_POINTS = 12000
MAX_OUT_EDGES = 48
Q15_OUT_SUM = 24576
NT_SIGN = {
    "ACH": 1.0,
    "GABA": -1.0,
    "GLUT": -1.0,
    "DA": 0.5,
    "SER": 0.5,
    "OCT": 0.5,
}


def rows(path):
    with gzip.open(path, "rt", newline="") as handle:
        reader = csv.reader(handle)
        next(reader, None)
        yield from reader


def parse_position(text):
    parts = text.strip().strip("[]").replace(",", " ").split()
    if len(parts) != 3:
        return None
    try:
        return tuple(float(value) for value in parts)
    except ValueError:
        return None


def quantize_xy(position, center_x, center_y, radius):
    x, y, _ = position
    nx = max(-0.94, min(0.94, (x - center_x) / radius))
    ny = max(-0.94, min(0.94, -(y - center_y) / radius))
    return int(round(nx * 32767)), int(round(ny * 32767))


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: build_data.py RAW_DIR OUTPUT_FILE")

    raw_dir, output_path = sys.argv[1:]
    coordinates_path = os.path.join(raw_dir, "coordinates.csv.gz")
    connections_path = os.path.join(raw_dir, "connections.csv.gz")

    for path in (coordinates_path, connections_path):
        if not os.path.isfile(path):
            raise SystemExit(f"missing input: {path}")

    print("Pass 1/3: ranking neurons by measured synapse strength")
    strength = defaultdict(int)
    connection_rows = 0
    for row in rows(connections_path):
        if len(row) < 4:
            continue
        pre, post = row[0], row[1]
        try:
            synapses = int(row[3])
        except ValueError:
            continue
        strength[pre] += synapses
        strength[post] += synapses
        connection_rows += 1

    ranked = sorted(strength, key=lambda rid: (-strength[rid], rid))
    candidate_ids = set(ranked[: min(len(ranked), MAX_NODES * 8)])

    print("Pass 2/3: loading measured soma coordinates")
    positions = {}
    all_positions = []
    min_x = min_y = float("inf")
    max_x = max_y = float("-inf")

    for row in rows(coordinates_path):
        if len(row) < 2:
            continue
        rid = row[0]
        position = parse_position(row[1])
        if position is None:
            continue
        x, y, _ = position
        min_x = min(min_x, x)
        max_x = max(max_x, x)
        min_y = min(min_y, y)
        max_y = max(max_y, y)
        all_positions.append((rid, position))
        if rid in candidate_ids and rid not in positions:
            positions[rid] = position

    selected_ids = [rid for rid in ranked if rid in positions][:MAX_NODES]
    if len(selected_ids) < 64:
        raise SystemExit(f"too few neurons with coordinates: {len(selected_ids)}")

    selected_index = {rid: index for index, rid in enumerate(selected_ids)}
    node_count = len(selected_ids)

    if not all_positions or not math.isfinite(min_x + min_y + max_x + max_y):
        raise SystemExit("no valid coordinates")

    center_x = (min_x + max_x) * 0.5
    center_y = (min_y + max_y) * 0.5
    radius = max(max_x - min_x, max_y - min_y) * 0.5
    if radius <= 0:
        raise SystemExit("invalid coordinate extent")

    if len(all_positions) <= MAX_VIZ_POINTS:
        viz_source = all_positions
    else:
        step = len(all_positions) / MAX_VIZ_POINTS
        viz_source = [all_positions[min(len(all_positions) - 1, int(i * step))] for i in range(MAX_VIZ_POINTS)]

    viz_points = [quantize_xy(position, center_x, center_y, radius) for _, position in viz_source]
    node_points = [quantize_xy(positions[rid], center_x, center_y, radius) for rid in selected_ids]
    hashes = [zlib.crc32(rid.encode("ascii")) & 0xFFFFFFFF for rid in selected_ids]

    print("Pass 3/3: extracting measured directed connections")
    outgoing = defaultdict(list)
    for row in rows(connections_path):
        if len(row) < 5:
            continue
        src = selected_index.get(row[0])
        dst = selected_index.get(row[1])
        if src is None or dst is None or src == dst:
            continue
        try:
            synapses = int(row[3])
        except ValueError:
            continue
        if synapses <= 0:
            continue
        nt = row[4].strip().upper()
        sign = NT_SIGN.get(nt, 0.25)
        raw_weight = sign * math.log1p(synapses)
        outgoing[src].append((dst, raw_weight, synapses))

    offsets = [0]
    packed_edges = []
    for src in range(node_count):
        edges = outgoing.get(src, [])
        edges.sort(key=lambda edge: (-abs(edge[1]), -edge[2], edge[0]))
        edges = edges[:MAX_OUT_EDGES]
        total = sum(abs(edge[1]) for edge in edges)
        if total > 0:
            for dst, raw_weight, _ in edges:
                q15 = int(round((raw_weight / total) * Q15_OUT_SUM))
                q15 = max(-32767, min(32767, q15))
                if q15 != 0:
                    packed_edges.append((dst, q15))
        offsets.append(len(packed_edges))

    edge_count = len(packed_edges)
    if edge_count == 0:
        raise SystemExit("selected circuit contains no connections")

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    with open(output_path, "wb") as output:
        output.write(struct.pack("<4sHHIII", b"FLYM", 1, 0, len(viz_points), node_count, edge_count))
        for x, y in viz_points:
            output.write(struct.pack("<hh", x, y))
        for (x, y), node_hash in zip(node_points, hashes):
            output.write(struct.pack("<hhI", x, y, node_hash))
        for value in offsets:
            output.write(struct.pack("<I", value))
        for dst, weight in packed_edges:
            output.write(struct.pack("<Hh", dst, weight))

    size_kib = os.path.getsize(output_path) / 1024
    print(f"raw connection rows: {connection_rows:,}")
    print(f"visualization points: {len(viz_points):,}")
    print(f"simulation neurons: {node_count:,}")
    print(f"simulation edges: {edge_count:,}")
    print(f"output: {output_path} ({size_kib:.1f} KiB)")


if __name__ == "__main__":
    main()

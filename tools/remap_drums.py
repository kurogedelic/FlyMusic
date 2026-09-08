#!/usr/bin/env python3
import struct
import sys
from pathlib import Path


def chunks(data, start, end):
    offset = start
    while offset + 8 <= end:
        chunk_id = bytes(data[offset:offset + 4])
        size = struct.unpack_from('<I', data, offset + 4)[0]
        payload = offset + 8
        yield chunk_id, payload, size
        offset = payload + size + (size & 1)


def find_list(data, list_type):
    for chunk_id, payload, size in chunks(data, 12, len(data)):
        if chunk_id == b'LIST' and bytes(data[payload:payload + 4]) == list_type:
            return payload + 4, payload + size
    raise RuntimeError(f'LIST {list_type!r} not found')


def c_string(raw):
    return bytes(raw).split(b'\0', 1)[0].decode('latin1')


def main():
    if len(sys.argv) != 2:
        raise SystemExit('usage: remap_drums.py <drums.sf2>')

    path = Path(sys.argv[1])
    data = bytearray(path.read_bytes())
    pdta_start, pdta_end = find_list(data, b'pdta')
    sections = {cid: (payload, size) for cid, payload, size in chunks(data, pdta_start, pdta_end)}

    for required in (b'pgen', b'inst', b'ibag', b'igen', b'shdr'):
        if required not in sections:
            raise RuntimeError(f'{required!r} missing from SoundFont')

    # The FreePats Synthesizer Percussion preset is globally limited to keys 48..66.
    # Expand it so the engine's compact drum mapping can use familiar GM-like keys.
    pgen_payload, pgen_size = sections[b'pgen']
    for pos in range(pgen_payload, pgen_payload + pgen_size, 4):
        oper, amount = struct.unpack_from('<HH', data, pos)
        if oper == 43:  # keyRange
            low, high = amount & 0xff, amount >> 8
            if low == 48 and high == 66:
                struct.pack_into('<H', data, pos + 2, 36 | (66 << 8))

    shdr_payload, shdr_size = sections[b'shdr']
    sample_names = []
    for pos in range(shdr_payload, shdr_payload + shdr_size, 46):
        sample_names.append(c_string(data[pos:pos + 20]))

    target_by_name = {
        'Kick04': 36,
        'Kick06': 49,
        'Snare09': 38,
        'Snare14': 39,
        'ClosedHiHat01-01': 42,
        'ClosedHiHat02-01': 43,
        'OpenHiHat02-01': 46,
    }
    target_by_sample = {
        index: target_by_name[name]
        for index, name in enumerate(sample_names)
        if name in target_by_name
    }

    inst_payload, inst_size = sections[b'inst']
    inst_bags = []
    for pos in range(inst_payload, inst_payload + inst_size, 22):
        inst_bags.append(struct.unpack_from('<H', data, pos + 20)[0])
    if len(inst_bags) < 2:
        raise RuntimeError('invalid instrument table')

    ibag_payload, ibag_size = sections[b'ibag']
    bags = []
    for pos in range(ibag_payload, ibag_payload + ibag_size, 4):
        bags.append(struct.unpack_from('<HH', data, pos))

    igen_payload, igen_size = sections[b'igen']
    gen_count = igen_size // 4

    for bag_index in range(inst_bags[0], inst_bags[1]):
        gen_start = bags[bag_index][0]
        gen_end = bags[bag_index + 1][0]
        key_pos = None
        sample_id = None
        for gen_index in range(gen_start, min(gen_end, gen_count)):
            pos = igen_payload + gen_index * 4
            oper, amount = struct.unpack_from('<HH', data, pos)
            if oper == 43:
                key_pos = pos + 2
            elif oper == 53:
                sample_id = amount
        if sample_id in target_by_sample and key_pos is not None:
            note = target_by_sample[sample_id]
            struct.pack_into('<H', data, key_pos, note | (note << 8))

    # Keep every remapped sample at its original pitch after moving it to a new key.
    for sample_id, note in target_by_sample.items():
        record = shdr_payload + sample_id * 46
        data[record + 40] = note

    path.write_bytes(data)
    labels = ', '.join(f'{sample_names[i]}={note}' for i, note in sorted(target_by_sample.items()))
    print(f'Remapped drum keys: {labels}')


if __name__ == '__main__':
    main()

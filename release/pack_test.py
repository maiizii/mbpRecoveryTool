import os, zipfile, time, json
root='.'
outdir='release'
ts=time.strftime('%Y%m%d-%H%M%S')
out=os.path.join(outdir, f'myt-recovery-tool-test-{ts}.zip')
exclude_prefixes=('node_modules/','tmp/','release/','.git/','__pycache__/')
exclude_suffixes=('.log','.zip')
include_release_files={'release/TEST-PACK-README.txt'}
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
    for base, dirs, files in os.walk(root):
        relbase=os.path.relpath(base, root)
        if relbase == '.':
            relbase=''
        dirs[:] = [d for d in dirs if not any(((relbase + '/' + d).strip('/') + '/').startswith(p) for p in exclude_prefixes)]
        for f in files:
            rel=(os.path.join(relbase,f)).strip('./') if relbase else f
            rel=rel.replace('\\','/')
            if rel in include_release_files:
                z.write(os.path.join(base,f), rel)
                continue
            if any(rel.startswith(p) for p in exclude_prefixes):
                continue
            if any(rel.endswith(s) for s in exclude_suffixes):
                continue
            z.write(os.path.join(base,f), rel)
print(json.dumps({'package': out, 'size_bytes': os.path.getsize(out)}, ensure_ascii=False))

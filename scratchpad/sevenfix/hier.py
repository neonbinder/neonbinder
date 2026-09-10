import sys, json
def walk(n, out, depth=0):
    a = n.get('attributes', {}) or {}
    txt = a.get('text') or ''
    rid = a.get('resource-id') or ''
    b = a.get('bounds') or ''
    if txt or rid:
        out.append((b, rid, txt[:90]))
    for c in n.get('children', []) or []:
        walk(c, out, depth+1)
d = json.load(open(sys.argv[1]))
out=[]
walk(d, out)
filt = sys.argv[2] if len(sys.argv)>2 else None
print("ROOT bounds:", (d.get('attributes') or {}).get('bounds'))
for b, rid, txt in out:
    line = f"{b:28} id={rid[:60]:60} text={txt}"
    if filt is None or filt.lower() in line.lower():
        print(line)

"""Fetches a themed photo set from Openverse (Creative Commons) for tuning the web engine's scene table.

Run from this folder. One folder per scene under .work/photos, 12 photos each from two searches, one photo per creator so a single photo
set cannot make up a scene. Writes .work/photos/<scene>/<n>.jpg and .work/photos/index.json.
"""
import json, os, time, urllib.parse, urllib.request

WORK = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.work')
os.makedirs(WORK, exist_ok=True)
os.chdir(WORK)

UA = {'User-Agent': 'lightsnip-label-bench/1.0'}
PER_QUERY = 6

QUERIES = {
    'screen': ['smartphone screenshot app', 'computer screen website'],
    'game': ['board game table', 'playing cards poker chips'],
    'sport': ['football match players', 'skateboarder trick'],
    'food': ['plate of food restaurant', 'latte coffee cup'],
    'party': ['party dancing friends', 'concert crowd stage lights'],
    'birthday': ['birthday cake candles', 'birthday party balloons'],
    'love': ['wedding bride groom', 'couple kissing'],
    'fashion': ['street style outfit', 'fashion model runway'],
    'pet': ['dog portrait', 'cat pet home'],
    'kids': ['baby toddler', 'children playground'],
    'people': ['selfie smiling', 'group of friends portrait'],
    'home': ['living room interior', 'bedroom interior'],
    'sunset': ['sunset sky', 'sunrise over sea'],
    'beach': ['sandy beach sea', 'tropical beach palm'],
    'nature': ['mountain landscape', 'forest lake'],
    'city': ['city skyline skyscrapers', 'busy city street'],
    'travel': ['airplane airport', 'road trip car highway'],
    'night': ['night sky stars', 'city at night neon'],
}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        return r.read()


index = []
for scene, queries in QUERIES.items():
    os.makedirs(f'photos/{scene}', exist_ok=True)
    creators, n = set(), 0
    for q in queries:
        taken = 0
        url = 'https://api.openverse.org/v1/images/?' + urllib.parse.urlencode(
            {'q': q, 'page_size': 20, 'mature': 'false', 'category': 'photograph'})
        results = json.loads(get(url)).get('results', [])
        for r in results:
            if taken >= PER_QUERY:
                break
            creator = (r.get('creator') or r['id']).lower()
            if creator in creators:
                continue
            try:
                data = get(r['thumbnail'])
            except Exception as e:
                print('  skip', r['id'], e)
                continue
            if len(data) < 4000:
                continue
            path = f'photos/{scene}/{n}.jpg'
            open(path, 'wb').write(data)
            creators.add(creator)
            index.append({'file': path, 'scene': scene, 'query': q, 'title': r.get('title'),
                          'creator': r.get('creator'), 'license': r.get('license'),
                          'source': r.get('foreign_landing_url')})
            n += 1
            taken += 1
        time.sleep(1.0)
    print(scene, n)

json.dump(index, open('photos/index.json', 'w'), indent=1)
print('total', len(index))

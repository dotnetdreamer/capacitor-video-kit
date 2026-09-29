/**
 * What a picture or a clip SHOWS, in words that are the same on every phone.
 *
 * `labelMedia` answers in the engine's own vocabulary. Vision knows 1303 things and names them in
 * `snake_case` (`birthday_cake`, `sunset_sunrise`); ML Kit knows 447 and names them in English
 * (`Cake`, `Sunset`). They also score differently: Vision gives a parent label the confidence of
 * its child (a cake is `food`, `dessert`, `baked_goods` and `cake` at once, all at 0.72), and ML
 * Kit's calibrated scores run high on a handful of labels it sees in almost anything - `Dog`,
 * `Event`, `Fun`, `Flesh` - so a host reading the raw labels needs two readers and a list of the
 * words it should not trust. This file is that reader, once, for every host: each engine's labels
 * go through a table of their own into one set of [MediaScene]s.
 *
 * The tables were built against both engines' real answers for ninety photographs of the themes
 * a video app gets - beaches, parties, food, pets, sport, cities, couples, outfits - and for
 * frames of screen-recorded games, read by Vision's two classifier revisions on this machine and
 * by the exact model file ML Kit bundles, with its own score calibration. A label goes in when it
 * says the scene in the pictures that are that scene and stays quiet in the ones that are not;
 * a label one engine gives freely to the wrong pictures goes in with a FLOOR, a confidence below
 * which it counts for nothing (ML Kit's `Dog` reaches 0.79 on a city bridge at night, and 0.97 on
 * a dog), or is left out.
 *
 * Pure data and pure functions, with no Capacitor in reach, so the editor's own entry point can
 * carry it too and a host can check its catalogue against [MEDIA_SCENES] in Node.
 */
import type { LabelEngine, LabeledFrame } from './definitions';

/**
 * A kind of footage, as a video app thinks of it.
 *
 *  - `screen`: a screen recording or a screenshot - a game, an app.
 *  - `game`: a game, on a screen or on a table: a video game, a board game, cards, chess.
 *  - `sport`: sport, fitness, and anything done on a board, a bike or skis.
 *  - `food`: food and drink, a meal, a coffee.
 *  - `party`: a night out, a concert, dancing, fireworks, a festive day.
 *  - `birthday`: a birthday cake, candles, balloons, presents.
 *  - `love`: a wedding, a couple. Vision sees a wedding and not a couple; ML Kit sees both.
 *  - `fashion`: what somebody is wearing: an outfit, shoes, a bag.
 *  - `pet`: a dog, a cat, a pet of any kind.
 *  - `kids`: a baby, a child, a playground, toys.
 *  - `people`: people, a face, a selfie, a crowd.
 *  - `home`: indoors at home: a living room, a bedroom, a kitchen.
 *  - `sunset`: a sunset or a sunrise, the light of golden hour.
 *  - `beach`: a beach, the sea, surfing, swimming.
 *  - `nature`: landscape: mountains, forests, lakes, snow, fields.
 *  - `city`: a city: buildings, skylines, streets.
 *  - `travel`: being on the way: planes, luggage, roads, boats.
 *  - `night`: the night sky, the moon, neon.
 */
export type MediaScene =
  | 'screen'
  | 'game'
  | 'sport'
  | 'food'
  | 'party'
  | 'birthday'
  | 'love'
  | 'fashion'
  | 'pet'
  | 'kids'
  | 'people'
  | 'home'
  | 'sunset'
  | 'beach'
  | 'nature'
  | 'city'
  | 'travel'
  | 'night';

/** Every scene, in the order [MediaScene] lists them. */
export const MEDIA_SCENES: readonly MediaScene[] = [
  'screen',
  'game',
  'sport',
  'food',
  'party',
  'birthday',
  'love',
  'fashion',
  'pet',
  'kids',
  'people',
  'home',
  'sunset',
  'beach',
  'nature',
  'city',
  'travel',
  'night',
];

/** How strongly a scene is in a picture, a clip or a set of them. */
export interface SceneScore {
  scene: MediaScene;
  /**
   * 0 to 1: how sure the engine was that the scene is there, and in how much of the footage. A
   * scene in every frame at 0.8 is 0.8; in one frame of five at 0.8, it is 0.16.
   */
  score: number;
}

/**
 * How much one label says for a scene: its confidence times `weight`, never more than 1, or nothing
 * below `floor`. A number alone is a weight with no floor. A weight above 1 is for a label that its
 * engine is never surer of than of a parent meaning another scene: it lets the label win at the
 * parent's confidence, and the cap keeps it to one whole scene at most.
 */
type Rule = number | readonly [weight: number, floor: number];

type SceneTable = Readonly<Record<MediaScene, Readonly<Record<string, Rule>>>>;

/*
 * VISION. Its parents come in with their children at the same confidence, so a parent that means
 * the scene - `food`, `drink`, `sport` - is the rule and its children add nothing. `recreation` is
 * left out: it is the parent of skating and of a concert alike. `liquid` too, the parent of a
 * coffee and of a lake, and `document`, which a screenshot always brings with it and a photo of a
 * page brings alone. Vision's false labels are rare and weak (the worst in the photographs was
 * `dolphin` at 0.18 for a fountain), so it needs no floors.
 */
const VISION: SceneTable = {
  screen: { screenshot: 1, videogame: 0.9 },
  game: {
    videogame: 1,
    games: 0.9,
    board_game: 0.9,
    backgammon: 0.8,
    chess: 0.8,
    gamepad: 0.8,
    joystick: 0.7,
    poker: 0.7,
    play_card: 0.7,
    casino: 0.6,
    roulette: 0.6,
    dice: 0.6,
    domino: 0.6,
    foosball: 0.5,
  },
  sport: {
    sport: 0.9,
    athletics: 1,
    ballgames: 1,
    basketball: 1,
    baseball: 1,
    football: 1,
    soccer: 1,
    tennis: 1,
    volleyball: 1,
    rugby: 1,
    hockey: 1,
    golf: 0.9,
    boxing: 1,
    kickboxing: 1,
    martial_arts: 1,
    wrestling: 1,
    sumo: 1,
    fencing_sport: 1,
    gymnastics: 1,
    cycling: 1,
    skating: 1,
    skateboarding: 1,
    skatepark: 0.9,
    rollerskating: 1,
    ice_skating: 1,
    skiing: 1,
    snowboarding: 1,
    surfing: 1,
    swimming: 0.9,
    diving: 0.9,
    scuba: 0.8,
    wakeboarding: 1,
    kiteboarding: 1,
    windsurfing: 1,
    rafting: 1,
    kayak: 0.7,
    rock_climbing: 1,
    workout: 1,
    barbell: 1,
    dumbbell: 1,
    treadmill: 0.9,
    health_club: 0.9,
    yoga: 0.8,
    motorsport: 1,
    motocross: 1,
    formula_one_car: 0.9,
    nascar: 1,
    grand_prix: 1,
    go_kart: 0.9,
    equestrian: 0.9,
    dressage: 0.9,
    jockey_horse: 0.9,
    rodeo: 0.9,
    archery: 1,
    badminton: 1,
    squash_sport: 1,
    ping_pong: 1,
    bowling: 0.8,
    skydiving: 1,
    parachute: 0.7,
    parasailing: 0.8,
    hangglider: 0.9,
    bungee: 0.9,
    hurdle: 1,
    stadium: 0.8,
    arena: 0.6,
    scoreboard: 0.8,
    bleachers: 0.6,
    cheerleading: 0.8,
    softball: 1,
    cricket_sport: 1,
    polo: 1,
    waterpolo: 1,
    frisbee: 0.7,
    trampoline: 0.6,
    snowmobile: 0.7,
    sledding: 0.7,
    atv: 0.8,
    puck: 0.8,
    racquet: 0.7,
    ball: 0.5,
  },
  food: {
    food: 1,
    drink: 0.75,
    coffee: 0.9,
    tea_drink: 0.8,
    smoothie: 0.8,
    milkshake: 0.8,
    bubble_tea: 0.8,
    juice: 0.7,
    cocktail: 0.6,
    beer: 0.5,
    wine: 0.5,
    restaurant: 0.6,
    plate: 0.5,
    cup: 0.5,
    mug: 0.6,
    tableware: 0.35,
  },
  party: {
    nightclub: 1,
    deejay: 1,
    disco_ball: 1,
    concert: 0.9,
    karaoke: 0.9,
    fireworks: 0.9,
    firecracker: 0.8,
    sparkler: 0.9,
    pyrotechnics: 0.9,
    dancing: 0.8,
    carnival: 0.8,
    // Below 1: Vision names a wedding `celebration` and `ceremony` too, at the wedding's own
    // confidence, so at 1 every wedding tied `love` here and went to `party` on [MEDIA_SCENES] order.
    celebration: 0.8,
    parade: 0.7,
    dragon_parade: 0.7,
    santa_claus: 0.7,
    graduation: 0.7,
    christmas_tree: 0.6,
    christmas_decoration: 0.6,
    jack_o_lantern: 0.6,
    crowd: 0.6,
    singer: 0.6,
    performance: 0.6,
    fairground: 0.6,
    amusement_park: 0.6,
    breakdancing: 0.6,
    bellydance: 0.6,
    samba: 0.6,
    hula: 0.6,
    // A birthday is a party as well, below `birthday` itself, as a balloon and a gift are.
    birthday_cake: 0.6,
    sparkling_wine: 0.5,
    costume: 0.5,
    entertainer: 0.5,
    ferris_wheel: 0.5,
    rollercoaster: 0.5,
    balloon: 0.5,
    cocktail: 0.4,
    gift: 0.4,
    spotlight: 0.4,
  },
  birthday: {
    // Above 1: its parents `cake`, `dessert`, `baked_goods` and `food` always come at least as sure
    // as it does, so at 1 every birthday cake was `food` first. A label's strength stops at 1
    // ([scenesFromLabels]), so a sure birthday cake is a whole birthday and no more.
    birthday_cake: 1.25,
    candle: 0.6,
    balloon: 0.6,
    gift: 0.6,
    cake: 0.6,
    cupcake: 0.5,
  },
  love: {
    wedding: 1,
    bride: 1,
    groom: 1,
    wedding_dress: 1,
    wedding_cake: 0.9,
    bridesmaid: 0.9,
    bouquet: 0.5,
    ceremony: 0.5,
    tuxedo: 0.4,
  },
  fashion: {
    high_heel: 0.9,
    gown: 0.9,
    purse: 0.8,
    jeans: 0.8,
    sneaker: 0.8,
    boot: 0.7,
    footwear: 0.65,
    beanie: 0.6,
    fedora: 0.6,
    clothing: 0.55,
    jacket: 0.5,
    hoodie: 0.5,
    scarf: 0.5,
    hat: 0.5,
    sunhat: 0.5,
    suit: 0.5,
    sari: 0.5,
    kimono: 0.5,
    jewelry: 0.5,
    necktie: 0.5,
    bowtie: 0.5,
    cosmetic_tool: 0.5,
    sunglasses: 0.4,
  },
  pet: {
    dog: 1,
    cat: 1,
    canine: 1,
    feline: 1,
    kitten: 1,
    adult_cat: 1,
    leash: 0.8,
    hamster: 0.9,
    gerbil: 0.9,
    chinchilla: 0.8,
    ferret: 0.8,
    rabbit: 0.8,
    parakeet: 0.8,
    goldfish: 0.7,
    fishbowl: 0.7,
    parrot: 0.6,
    cockatoo: 0.6,
  },
  kids: {
    baby: 1,
    pacifier: 0.9,
    child: 0.8,
    crib: 0.8,
    diaper: 0.8,
    stroller: 0.8,
    high_chair: 0.8,
    playground: 0.7,
    swing_playground: 0.7,
    slide_toy: 0.7,
    stuffed_animals: 0.6,
    toy: 0.5,
    doll: 0.5,
  },
  people: { people: 0.5, crowd: 0.5, adult: 0.45, child: 0.45, teen: 0.45, baby: 0.45 },
  home: {
    living_room: 1,
    bedroom: 1,
    kitchen_room: 1,
    dining_room: 1,
    kitchen: 0.9,
    interior_room: 0.8,
    bathroom_room: 0.8,
    kitchen_countertop: 0.8,
    sofa: 0.8,
    bed: 0.8,
    armchair: 0.7,
    fireplace: 0.7,
    bedding: 0.6,
    bookshelf: 0.6,
    pillow: 0.5,
    curtain: 0.5,
  },
  sunset: { sunset_sunrise: 1 },
  beach: {
    beach: 1,
    sandcastle: 1,
    shore: 0.9,
    sunbathing: 0.9,
    surfing: 0.9,
    surfboard: 0.8,
    bodyboard: 0.8,
    swimsuit: 0.7,
    ocean: 0.55,
    seashell: 0.7,
    sand: 0.6,
    island: 0.6,
    snorkeling: 0.6,
    kiteboarding: 0.6,
    windsurfing: 0.6,
    coral_reef: 0.5,
    pier: 0.5,
    jetski: 0.5,
    palm_tree: 0.35,
  },
  nature: {
    mountain: 1,
    forest: 1,
    jungle: 1,
    canyon: 1,
    glacier: 1,
    volcano: 1,
    waterfall: 1,
    aurora: 1,
    cliff: 0.9,
    desert: 0.9,
    sand_dune: 0.9,
    iceberg: 0.9,
    geyser: 0.9,
    hiking: 0.9,
    hill: 0.8,
    lake: 0.8,
    river: 0.8,
    creek: 0.8,
    wetland: 0.8,
    rainbow: 0.8,
    cave: 0.8,
    camping: 0.8,
    trail: 0.8,
    rice_field: 0.8,
    snow: 0.7,
    ocean: 0.6,
    vineyard: 0.7,
    blizzard: 0.6,
    tent: 0.6,
    orchard: 0.6,
    park: 0.5,
    garden: 0.5,
    farm: 0.5,
    flower: 0.4,
    foliage: 0.4,
    vegetation: 0.4,
    tree: 0.3,
    grass: 0.25,
  },
  city: {
    cityscape: 1,
    skyscraper: 1,
    street: 0.8,
    alley: 0.8,
    crosswalk: 0.8,
    storefront: 0.8,
    castle: 0.7,
    clock_tower: 0.7,
    traffic_light: 0.7,
    building: 0.6,
    tower: 0.6,
    bridge: 0.6,
    monument: 0.6,
    museum: 0.6,
    street_sign: 0.6,
    graffiti: 0.6,
    streetcar: 0.6,
    tramway: 0.6,
    train_station: 0.6,
    dome: 0.5,
    sidewalk: 0.5,
    parking_lot: 0.5,
    bus: 0.5,
    obelisk: 0.5,
    belltower: 0.5,
  },
  travel: {
    airplane: 1,
    airport: 1,
    luggage: 1,
    suitcase: 1,
    passport: 1,
    cruise_ship: 0.9,
    motorhome: 0.9,
    aircraft: 0.8,
    dirt_road: 0.8,
    balloon_hotair: 0.8,
    road: 0.7,
    train_real: 0.7,
    cableway: 0.7,
    railroad: 0.6,
    sailboat: 0.6,
    yacht: 0.6,
    lighthouse: 0.6,
    harbour: 0.6,
    boat: 0.5,
    jeep: 0.5,
    helicopter: 0.5,
    camping: 0.5,
    map: 0.4,
    van: 0.4,
    suv: 0.4,
    motorcycle: 0.4,
    tent: 0.4,
    backpack: 0.4,
    automobile: 0.3,
  },
  night: { night_sky: 1, nightclub: 0.8, moon: 0.7, aurora: 0.6, fireworks: 0.6 },
};

/*
 * ML KIT, as the bundled base model scores its labels once its own calibration has been applied.
 * It names a thing once rather than with its parents, and gives it a score that means more than
 * Vision's does, except for the labels it hands out to nearly any picture: `Event` (0.94 for a
 * sunset), `Fun`, `Leisure`, `Flesh`, `Eyelash`, `Sky`, `Toy` (0.8 on a board game's screen),
 * `Bird`, `Horse`. Those are left out, and the ones that are right when they are sure and wrong
 * when they are not - `Dog`, `Cat`, `Jeans`, `Food`, `Christmas` - have a floor. `Pet` is the
 * label that separates a pet from a picture ML Kit merely thinks has a dog in it: 0.84 to 0.97 on
 * every pet in the photographs, and absent from all the rest.
 */
const MLKIT: SceneTable = {
  screen: { screenshot: [1, 0.35], web_page: 0.9 },
  game: { casino: 0.6 },
  sport: {
    sports: 1,
    soccer: 1,
    rugby: 1,
    softball: 1,
    badminton: 1,
    curling: 1,
    gymnastics: 1,
    running: 1,
    marathon: 1,
    cycling: 1,
    skateboarder: 1,
    surfing: 1,
    skiing: 1,
    snowboarding: 1,
    wakeboarding: 1,
    waterskiing: 1,
    windsurfing: 1,
    rafting: 1,
    rowing: 1,
    archery: 1,
    polo: 0.9,
    race: 0.9,
    racing: 0.9,
    skateboard: 0.9,
    longboard: 0.9,
    swimming: 0.9,
    scuba_diving: 0.9,
    stadium: 0.8,
    kayak: 0.8,
    rodeo: 0.8,
    competition: 0.7,
    pitch: 0.7,
    sledding: 0.7,
    snorkeling: 0.7,
    unicycle: 0.7,
    team: 0.6,
    bicycle: 0.6,
    roller: 0.6,
    canoe: 0.6,
    tubing: 0.6,
    bullfighting: 0.6,
    muscle: 0.6,
    jersey: 0.6,
    helmet: 0.3,
  },
  food: {
    food: [1, 0.5],
    cuisine: [1, 0.5],
    meal: 1,
    fast_food: 1,
    pizza: 1,
    sushi: 1,
    cappuccino: 1,
    gelato: 1,
    pho: 1,
    couscous: 1,
    bento: 1,
    cheeseburger: 1,
    lunch: 0.9,
    supper: 0.9,
    coffee: 0.9,
    pie: 0.9,
    pasteles: 0.9,
    hot_dog: 0.9,
    eating: 0.8,
    cake: 0.8,
    bread: 0.8,
    juice: 0.8,
    cookie: 0.8,
    icing: 0.7,
    cola: 0.6,
    picnic: 0.6,
    fruit: [0.6, 0.5],
    vegetable: [0.6, 0.5],
    steaming: 0.5,
    cutlery: 0.4,
    saucer: 0.4,
    cup: 0.4,
    wine: 0.4,
    alcohol: 0.4,
    menu: 0.4,
    tableware: 0.35,
  },
  party: {
    party: 1,
    nightclub: 1,
    deejay: 1,
    concert: 0.9,
    fireworks: 0.9,
    sparkler: 0.9,
    prom: 0.9,
    dance: 0.8,
    carnival: 0.8,
    santa_claus: 0.7,
    graduation: 0.7,
    crowd: 0.6,
    hanukkah: 0.6,
    christmas: [0.6, 0.85],
    pop_music: 0.6,
    singer: 0.6,
    ballroom: 0.6,
    mortarboard: 0.6,
    thanksgiving: 0.5,
    musician: 0.5,
    bar: 0.5,
    balloon: [0.4, 0.7],
    glitter: 0.4,
    neon: 0.4,
    casino: 0.4,
    alcohol: 0.3,
  },
  birthday: { cake: 0.7, icing: 0.6, balloon: [0.6, 0.7], party: 0.4, sparkler: 0.3 },
  love: {
    marriage: 1,
    bride: 1,
    groom: 1,
    love: 0.8,
    veil: 0.8,
    gown: 0.5,
    heart: 0.5,
    tuxedo: 0.4,
    ring: 0.4,
    interaction: 0.4,
  },
  fashion: {
    model: 0.9,
    dress: 0.8,
    handbag: 0.8,
    gown: 0.8,
    blazer: 0.7,
    sari: 0.7,
    jeans: [0.6, 0.7],
    denim: [0.6, 0.7],
    sneakers: 0.6,
    tuxedo: 0.6,
    leggings: 0.6,
    tights: 0.6,
    lipstick: 0.6,
    outerwear: 0.6,
    jacket: [0.5, 0.7],
    shoe: [0.5, 0.7],
    scarf: 0.5,
    beanie: 0.5,
    jewellery: 0.5,
    necklace: 0.5,
    bracelet: 0.5,
    bangle: 0.5,
    swimwear: 0.5,
    cap: 0.4,
    leather: 0.4,
    hat: 0.3,
    sunglasses: 0.3,
    glasses: 0.3,
  },
  pet: {
    pet: [1, 0.6],
    cat: [0.9, 0.9],
    dog: [0.9, 0.9],
    shetland_sheepdog: 0.8,
    dalmatian: 0.8,
    cavalier: 0.8,
    cairn_terrier: 0.8,
    basset_hound: 0.8,
    shikoku: 0.8,
    himalayan: 0.8,
    ragdoll: 0.8,
    sphynx: 0.8,
    pixie_bob: 0.8,
    gerbil: 0.8,
  },
  kids: { baby: 1, playground: 0.7, stuffed_toy: 0.6, plush: 0.6, lego: 0.5, swing: 0.5 },
  people: {
    selfie: 0.8,
    crowd: 0.5,
    smile: 0.5,
    laugh: 0.5,
    grandparent: 0.5,
    baby: 0.5,
    team: 0.4,
    dude: 0.4,
    beard: 0.4,
    moustache: 0.4,
    crew: 0.4,
    standing: 0.35,
    hand: 0.3,
    hair: 0.3,
  },
  home: {
    bedroom: 1,
    kitchen: 1,
    bathroom: 0.9,
    couch: 0.8,
    loveseat: 0.8,
    bunk_bed: 0.8,
    room: [0.6, 0.65],
    cushion: 0.6,
    cabinetry: 0.6,
    countertop: 0.6,
    pillow: 0.5,
    curtain: 0.5,
    shelf: 0.5,
    sleep: 0.5,
  },
  sunset: { sunset: 1 },
  beach: {
    beach: 1,
    surfing: 0.9,
    surfboard: 0.8,
    swimwear: 0.7,
    sand: 0.6,
    reef: 0.6,
    snorkeling: 0.6,
    windsurfing: 0.6,
    pier: 0.5,
    waterskiing: 0.5,
    swimming: 0.5,
  },
  nature: {
    mountain: 1,
    forest: 1,
    jungle: 1,
    canyon: 1,
    glacier: 1,
    volcano: 1,
    waterfall: 1,
    aurora: 1,
    cliff: 0.9,
    desert: 0.9,
    dune: 0.9,
    iceberg: 0.9,
    lake: 0.8,
    swamp: 0.8,
    cave: 0.8,
    caving: 0.8,
    rainbow: 0.8,
    river: 0.7,
    camping: 0.7,
    backpacking: 0.7,
    prairie: 0.6,
    safari: 0.6,
    icicle: 0.5,
    storm: 0.5,
    lightning: 0.5,
    ranch: 0.5,
    farm: 0.5,
    garden: 0.5,
    waterfowl: 0.5,
    field: [0.4, 0.5],
    fog: 0.4,
    flora: 0.4,
    rock: 0.4,
    plant: [0.3, 0.6],
  },
  city: {
    skyline: 1,
    skyscraper: 1,
    castle: 0.7,
    palace: 0.7,
    cathedral: 0.7,
    building: 0.6,
    tower: 0.6,
    bridge: 0.6,
    monument: 0.6,
    church: 0.6,
    mosque: 0.6,
    temple: 0.6,
    museum: 0.6,
    bus: 0.5,
    infrastructure: 0.4,
    statue: [0.4, 0.7],
    train: 0.4,
    road: 0.35,
  },
  travel: {
    airplane: 1,
    airliner: 1,
    passport: 1,
    aircraft: [0.8, 0.75],
    aviation: [0.8, 0.6],
    backpacking: 0.8,
    safari: 0.8,
    vacation: 0.6,
    road: 0.45,
    train: 0.6,
    sailboat: 0.6,
    lighthouse: 0.6,
    boat: 0.5,
    van: 0.5,
    speedboat: 0.5,
    helicopter: 0.5,
    camping: 0.5,
    car: 0.4,
    pier: 0.4,
    kayak: 0.4,
    canoe: 0.4,
    vehicle: 0.3,
  },
  night: {
    nebula: 0.8,
    nightclub: 0.8,
    comet: 0.7,
    moon: 0.7,
    star: 0.6,
    neon: 0.6,
    fireworks: 0.6,
    aurora: 0.6,
    space: 0.5,
  },
};

/** ImageNet's 118 dog breeds, classes 151 to 268, as [sceneLabelKey] writes them. `cardigan` is left out: it is also the sweater. */
const DOG_BREEDS = (
  'chihuahua japanese_spaniel maltese_dog pekinese shih_tzu blenheim_spaniel papillon toy_terrier rhodesian_ridgeback ' +
  'afghan_hound basset beagle bloodhound bluetick black_and_tan_coonhound walker_hound english_foxhound redbone borzoi ' +
  'irish_wolfhound italian_greyhound whippet ibizan_hound norwegian_elkhound otterhound saluki scottish_deerhound ' +
  'weimaraner staffordshire_bullterrier american_staffordshire_terrier bedlington_terrier border_terrier ' +
  'kerry_blue_terrier irish_terrier norfolk_terrier norwich_terrier yorkshire_terrier wire_haired_fox_terrier ' +
  'lakeland_terrier sealyham_terrier airedale cairn australian_terrier dandie_dinmont boston_bull miniature_schnauzer ' +
  'giant_schnauzer standard_schnauzer scotch_terrier tibetan_terrier silky_terrier soft_coated_wheaten_terrier ' +
  'west_highland_white_terrier lhasa flat_coated_retriever curly_coated_retriever golden_retriever labrador_retriever ' +
  'chesapeake_bay_retriever german_short_haired_pointer vizsla english_setter irish_setter gordon_setter ' +
  'brittany_spaniel clumber english_springer welsh_springer_spaniel cocker_spaniel sussex_spaniel irish_water_spaniel ' +
  'kuvasz schipperke groenendael malinois briard kelpie komondor old_english_sheepdog shetland_sheepdog collie ' +
  'border_collie bouvier_des_flandres rottweiler german_shepherd doberman miniature_pinscher ' +
  'greater_swiss_mountain_dog bernese_mountain_dog appenzeller entlebucher boxer bull_mastiff tibetan_mastiff ' +
  'french_bulldog great_dane saint_bernard eskimo_dog malamute siberian_husky dalmatian affenpinscher basenji pug ' +
  'leonberg newfoundland great_pyrenees samoyed pomeranian chow keeshond brabancon_griffon pembroke toy_poodle ' +
  'miniature_poodle standard_poodle mexican_hairless'
).split(' ');

/*
 * MEDIAPIPE, the browser's engine: EfficientNet-Lite0 over ImageNet's 1000 classes (`web/labels.ts`).
 *
 * A vocabulary of THINGS - 118 dog breeds, a hundred foods, every kind of boat - with a handful of
 * places (`seashore`, `alp`, `valley`, `lakeside`) and nothing at all for a sunset, a person or the
 * night sky. So a browser never says `sunset` or `people`: a sunset over the sea is `seashore` to
 * it, and reads as a beach. What it does see it sees sharply, and its oddities are consistent enough
 * to use - fireworks are a `sea urchin` to it, a game's board and buttons a `slot` machine.
 *
 * Its scores are one softmax, so a picture's confidence is SPLIT between the classes that fit it (a
 * dog 0.4 one breed and 0.3 another, a beach `seashore` and `sandbar`), and this engine's labels ADD
 * UP within a frame (see [SUMMED]) where the phones' take the strongest.
 *
 * Built against the engine's real answers, in Chromium, for 301 pictures: twelve Creative Commons
 * photographs of each scene from Openverse, the 85 stills the template lab chose as footage, and 22
 * frames of screen-recorded games. A label goes in when most of its weight across them landed on
 * the scene; `fountain`, `crutch` and `restaurant`-as-anything-but-food, which it hands to lit
 * streets, weddings and concerts alike, stay out.
 */
const MEDIAPIPE: SceneTable = {
  screen: {
    web_site: 1,
    monitor: 0.9,
    screen: 0.9,
    slot: 0.8,
    hand_held_computer: 0.8,
    television: 0.7,
    laptop: 0.7,
    notebook: 0.7,
    desktop_computer: 0.7,
    ipod: 0.7,
    cellular_telephone: 0.7,
    joystick: 0.5,
    comic_book: 0.4,
    crossword_puzzle: 0.4,
    home_theater: 0.3,
  },
  game: {
    slot: 1,
    joystick: 1,
    pool_table: 0.8,
    jigsaw_puzzle: 0.7,
    crossword_puzzle: 0.6,
    comic_book: 0.4,
    remote_control: 0.4,
  },
  sport: {
    soccer_ball: 1,
    rugby_ball: 1,
    football_helmet: 1,
    basketball: 1,
    volleyball: 1,
    ballplayer: 1,
    ski: 1,
    bobsled: 1,
    barbell: 1,
    dumbbell: 1,
    balance_beam: 1,
    parallel_bars: 1,
    horizontal_bar: 1,
    punching_bag: 1,
    tennis_ball: 0.9,
    golf_ball: 0.9,
    puck: 0.9,
    racket: 0.9,
    scoreboard: 0.8,
    mountain_bike: 0.8,
    go_kart: 0.8,
    scuba_diver: 0.8,
    snowmobile: 0.7,
    dogsled: 0.7,
    racer: 0.7,
    knee_pad: 0.7,
    bicycle_built_for_two: 0.7,
    unicycle: 0.6,
    paddle: 0.6,
    crash_helmet: 0.6,
    croquet_ball: 0.5,
    jersey: 0.4,
    bannister: 0.4,
    spider_web: 0.4,
    snorkel: 0.4,
  },
  food: {
    espresso: 1,
    plate: 1,
    pizza: 1,
    cheeseburger: 1,
    hotdog: 1,
    ice_cream: 1,
    trifle: 1,
    consomme: 1,
    hot_pot: 1,
    carbonara: 1,
    burrito: 1,
    bagel: 1,
    pretzel: 1,
    guacamole: 1,
    mashed_potato: 1,
    meat_loaf: 1,
    potpie: 1,
    cup: 0.9,
    coffee_mug: 0.9,
    ice_lolly: 0.9,
    french_loaf: 0.9,
    soup_bowl: 0.9,
    eggnog: 0.8,
    dough: 0.8,
    chocolate_sauce: 0.8,
    red_wine: 0.8,
    espresso_maker: 0.8,
    wok: 0.8,
    head_cabbage: 0.8,
    broccoli: 0.8,
    cauliflower: 0.8,
    zucchini: 0.8,
    spaghetti_squash: 0.8,
    acorn_squash: 0.8,
    butternut_squash: 0.8,
    cucumber: 0.8,
    artichoke: 0.8,
    bell_pepper: 0.8,
    cardoon: 0.8,
    mushroom: 0.8,
    granny_smith: 0.8,
    strawberry: 0.8,
    orange: 0.8,
    lemon: 0.8,
    fig: 0.8,
    pineapple: 0.8,
    banana: 0.8,
    jackfruit: 0.8,
    custard_apple: 0.8,
    pomegranate: 0.8,
    menu: 0.7,
    beer_glass: 0.7,
    cocktail_shaker: 0.7,
    frying_pan: 0.7,
    dutch_oven: 0.7,
    coffeepot: 0.7,
    teapot: 0.7,
    bakery: 0.7,
    rotisserie: 0.7,
    wine_bottle: 0.6,
    beer_bottle: 0.6,
    crock_pot: 0.6,
    mixing_bowl: 0.6,
    confectionery: 0.6,
    waffle_iron: 0.6,
    saltshaker: 0.6,
    restaurant: 0.4,
    pop_bottle: 0.5,
    ladle: 0.5,
    wooden_spoon: 0.5,
    butcher_shop: 0.5,
    tray: 0.5,
    goblet: 0.5,
    cleaver: 0.5,
    corn: 0.5,
    grocery_store: 0.4,
    spatula: 0.4,
    strainer: 0.4,
    measuring_cup: 0.4,
    pitcher: 0.4,
  },
  party: {
    'stage': 0.8,
    'spotlight': 0.8,
    'sea_urchin': 0.6,
    'torch': 0.6,
    'electric_guitar': 0.6,
    'microphone': 0.5,
    'maypole': 0.5,
    'carousel': 0.5,
    'feather_boa': 0.5,
    "jack_o'_lantern": 0.5,
    'christmas_stocking': 0.5,
    'theater_curtain': 0.5,
    'balloon': 0.4,
    'drum': 0.4,
    'loudspeaker': 0.4,
    'cocktail_shaker': 0.4,
    'acoustic_guitar': 0.3,
    'mask': 0.3,
  },
  birthday: {
    candle: 1,
    balloon: 0.9,
    chocolate_sauce: 0.5,
    abacus: 0.5,
    matchstick: 0.4,
    pinwheel: 0.4,
    envelope: 0.3,
    trifle: 0.3,
  },
  love: { groom: 1, gown: 0.5, altar: 0.5, hoopskirt: 0.4 },
  fashion: {
    miniskirt: 0.9,
    jean: 0.8,
    fur_coat: 0.8,
    trench_coat: 0.8,
    purse: 0.8,
    loafer: 0.7,
    cowboy_boot: 0.7,
    suit: 0.6,
    overskirt: 0.6,
    cowboy_hat: 0.6,
    running_shoe: 0.6,
    sandal: 0.6,
    clog: 0.6,
    necklace: 0.6,
    lipstick: 0.6,
    gown: 0.5,
    abaya: 0.5,
    sarong: 0.5,
    bow_tie: 0.5,
    windsor_tie: 0.5,
    bolo_tie: 0.5,
    hair_slide: 0.5,
    face_powder: 0.5,
    perfume: 0.5,
    shoe_shop: 0.5,
    kimono: [0.5, 0.15],
    hoopskirt: 0.4,
    bonnet: 0.4,
    sombrero: 0.4,
    sock: 0.4,
    feather_boa: 0.4,
    poncho: [0.4, 0.2],
    bikini: [0.4, 0.2],
    brassiere: [0.4, 0.2],
    sweatshirt: [0.4, 0.3],
    stole: [0.4, 0.3],
    sunglasses: [0.4, 0.25],
    sunglass: [0.4, 0.25],
    cloak: [0.3, 0.2],
    cardigan: [0.3, 0.3],
    wig: [0.3, 0.25],
    umbrella: [0.3, 0.3],
    maillot: [0.3, 0.3],
    pajama: 0.3,
    wallet: 0.3,
  },
  pet: {
    ...Object.fromEntries(DOG_BREEDS.map(breed => [breed, 1])),
    tabby: 1,
    tiger_cat: 1,
    persian_cat: 1,
    siamese_cat: 1,
    egyptian_cat: 1,
    hamster: 0.8,
    guinea_pig: 0.8,
    angora: 0.8,
    goldfish: 0.7,
    macaw: 0.7,
    sulphur_crested_cockatoo: 0.7,
    lorikeet: 0.7,
    african_grey: 0.7,
    timber_wolf: 0.6,
    white_wolf: 0.6,
    coyote: 0.6,
    dingo: 0.6,
    red_fox: 0.6,
    arctic_fox: 0.6,
    kit_fox: 0.6,
    grey_fox: 0.6,
    wood_rabbit: 0.5,
    hare: 0.5,
    muzzle: 0.5,
  },
  kids: {
    diaper: 1,
    crib: 1,
    cradle: 0.9,
    bassinet: 0.9,
    bib: 0.8,
    nipple: 0.8,
    teddy: 0.8,
    tricycle: 0.7,
    swing: 0.7,
    toyshop: 0.6,
    motor_scooter: 0.3,
  },
  people: {},
  home: {
    four_poster: 1,
    studio_couch: 1,
    quilt: 0.9,
    home_theater: 0.8,
    entertainment_center: 0.8,
    dining_table: 0.7,
    bookcase: 0.7,
    wardrobe: 0.7,
    china_cabinet: 0.7,
    chiffonier: 0.7,
    bathtub: 0.7,
    shower_curtain: 0.7,
    window_shade: 0.6,
    rocking_chair: 0.6,
    pillow: 0.6,
    table_lamp: 0.6,
    lampshade: 0.6,
    fire_screen: 0.6,
    washbasin: 0.6,
    medicine_chest: 0.6,
    dishwasher: 0.6,
    refrigerator: 0.6,
    microwave: 0.6,
    stove: 0.6,
    vacuum: 0.6,
    sliding_door: 0.5,
    toilet_seat: 0.5,
    radiator: 0.5,
    toaster: 0.5,
    desk: 0.4,
    iron: 0.4,
    crib: 0.3,
    restaurant: 0.2,
  },
  sunset: {},
  beach: {
    seashore: 1,
    sandbar: 0.9,
    coral_reef: 0.8,
    bikini: 0.7,
    swimming_trunks: 0.7,
    snorkel: 0.7,
    breakwater: 0.6,
    pier: 0.6,
    promontory: 0.5,
    sunscreen: 0.5,
    maillot: 0.4,
    lakeside: 0.3,
  },
  nature: {
    'alp': 1,
    'valley': 1,
    'volcano': 1,
    'cliff': 0.9,
    'lakeside': 0.8,
    'geyser': 0.8,
    'rapeseed': 0.8,
    'hay': 0.6,
    'daisy': 0.6,
    'mountain_tent': 0.6,
    'cliff_dwelling': 0.6,
    'promontory': 0.5,
    "yellow_lady's_slipper": 0.5,
    'agaric': 0.5,
    'bolete': 0.5,
    'megalith': 0.5,
    'coral_reef': 0.4,
    'worm_fence': 0.4,
    'barn': 0.4,
    'harvester': 0.4,
  },
  city: {
    cab: 1,
    streetcar: 0.9,
    trolleybus: 0.9,
    street_sign: 0.8,
    traffic_light: 0.8,
    triumphal_arch: 0.8,
    parking_meter: 0.8,
    castle: 0.7,
    palace: 0.7,
    dome: 0.7,
    obelisk: 0.7,
    pay_phone: 0.7,
    church: 0.6,
    bell_cote: 0.6,
    mosque: 0.6,
    monastery: 0.6,
    suspension_bridge: 0.6,
    steel_arch_bridge: 0.6,
    tobacco_shop: 0.6,
    shoe_shop: 0.6,
    police_van: 0.6,
    manhole_cover: 0.6,
    stupa: 0.5,
    viaduct: 0.5,
    grocery_store: 0.5,
    barbershop: 0.5,
    bookshop: 0.5,
    mailbox: 0.5,
    fire_engine: 0.5,
    school_bus: 0.5,
    garbage_truck: 0.5,
    cinema: 0.4,
    bakery: 0.4,
    minibus: 0.4,
    tow_truck: 0.4,
    water_tower: 0.4,
  },
  travel: {
    airliner: 1,
    bullet_train: 0.9,
    liner: 0.9,
    recreational_vehicle: 0.9,
    wing: 0.8,
    jeep: 0.8,
    passenger_car: 0.8,
    electric_locomotive: 0.8,
    mobile_home: 0.8,
    beach_wagon: 0.7,
    steam_locomotive: 0.7,
    yawl: 0.7,
    catamaran: 0.7,
    trimaran: 0.7,
    schooner: 0.7,
    gondola: 0.7,
    warplane: 0.6,
    airship: 0.6,
    minivan: 0.6,
    convertible: 0.6,
    speedboat: 0.6,
    backpack: 0.6,
    mountain_tent: 0.6,
    car_mirror: 0.6,
    seat_belt: 0.6,
    container_ship: 0.5,
    canoe: 0.5,
    trailer_truck: 0.5,
    pickup: 0.5,
    sleeping_bag: 0.5,
    gas_pump: 0.5,
    odometer: 0.5,
    sports_car: 0.4,
    limousine: 0.4,
    aircraft_carrier: 0.4,
    lifeboat: 0.4,
    freight_car: 0.4,
    space_shuttle: 0.3,
    cab: 0.3,
  },
  night: { cinema: 0.6, planetarium: 0.6, sea_urchin: 0.4, spotlight: 0.3, torch: 0.3 },
};

/*
 * The engines whose labels ADD UP within a frame. MediaPipe's scores are one softmax, so the
 * classes that mean a scene share one picture's confidence between them, and the scene is as strong
 * as their sum. The phones' engines score each label on its own, where a sum would count a cake that
 * Vision names four ways four times, so they take the strongest.
 */
const SUMMED: ReadonlySet<LabelEngine> = new Set(['mediapipe']);

interface IndexedRule {
  readonly scene: MediaScene;
  readonly weight: number;
  readonly floor: number;
}

/** Each table turned inside out, label first, once: a label can say more than one scene. */
const INDEX: Readonly<Record<LabelEngine, ReadonlyMap<string, readonly IndexedRule[]>>> = {
  vision: indexOf(VISION),
  mlkit: indexOf(MLKIT),
  mediapipe: indexOf(MEDIAPIPE),
};

function indexOf(table: SceneTable): ReadonlyMap<string, readonly IndexedRule[]> {
  const index = new Map<string, IndexedRule[]>();
  for (const scene of MEDIA_SCENES) {
    for (const [label, rule] of Object.entries(table[scene])) {
      const [weight, floor] = typeof rule === 'number' ? [rule, 0] : rule;
      const rules = index.get(label) ?? [];
      rules.push({ scene, weight, floor });
      index.set(label, rules);
    }
  }
  return index;
}

/**
 * A label as the tables hold it: lower case, with a space or a hyphen as an underscore, so ML
 * Kit's `Fast food` and `Pixie-bob` are `fast_food` and `pixie_bob`. Vision's identifiers are
 * already in this form.
 */
export function sceneLabelKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/**
 * The labels a table reads for one engine, keyed as [sceneLabelKey] keys them, with the scenes
 * each one says. For a test that holds them against the engine's own vocabulary, and for a host
 * curious why a clip came out as it did.
 */
export function sceneLabels(engine: LabelEngine): ReadonlyMap<string, readonly MediaScene[]> {
  return new Map([...INDEX[engine]].map(([label, rules]) => [label, rules.map(rule => rule.scene)]));
}

/**
 * The scenes in the frames `labelMedia` answered with, strongest first.
 *
 * In each frame a scene is as strong as the strongest label that says it - its confidence times
 * the label's weight, never more than 1, and nothing below the label's floor - rather than the sum
 * of them: Vision names a cake four ways at one confidence, and a sum would count one cake four
 * times. MediaPipe is the exception ([SUMMED]): its classes split one confidence between them, so
 * there a scene is the sum of its labels' strengths, and never more than 1. Across the frames a
 * scene is the mean of its strength in each, so a scene seen throughout the clip beats a stronger
 * one seen once. A scene no label says is left out rather than listed at 0.
 */
export function scenesFromLabels(frames: readonly LabeledFrame[], engine: LabelEngine): SceneScore[] {
  const index = INDEX[engine];
  if (!index || frames.length === 0) return [];
  const summed = SUMMED.has(engine);
  const totals = new Map<MediaScene, number>();
  for (const frame of frames) {
    const inFrame = new Map<MediaScene, number>();
    for (const { label, confidence } of frame.labels) {
      if (!Number.isFinite(confidence) || confidence <= 0) continue;
      for (const rule of index.get(sceneLabelKey(label)) ?? []) {
        if (confidence < rule.floor) continue;
        const strength = Math.min(1, Math.min(1, confidence) * rule.weight);
        const before = inFrame.get(rule.scene) ?? 0;
        inFrame.set(rule.scene, summed ? Math.min(1, before + strength) : Math.max(before, strength));
      }
    }
    for (const [scene, strength] of inFrame) totals.set(scene, (totals.get(scene) ?? 0) + strength);
  }
  return ranked(totals, frames.length);
}

/**
 * What a set of pictures and clips shows as a whole: each scene's mean over the set, strongest
 * first, a member that does not show it counting as 0. Five food photos and five of a beach are
 * half food and half beach, and one food photo in ten is a tenth food.
 */
export function mergeScenes(members: readonly (readonly SceneScore[])[]): SceneScore[] {
  if (members.length === 0) return [];
  const totals = new Map<MediaScene, number>();
  for (const member of members) {
    for (const { scene, score } of member) totals.set(scene, (totals.get(scene) ?? 0) + score);
  }
  return ranked(totals, members.length);
}

function ranked(totals: ReadonlyMap<MediaScene, number>, count: number): SceneScore[] {
  return [...totals]
    .map(([scene, total]) => ({ scene, score: Math.round((total / count) * 1000) / 1000 }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || MEDIA_SCENES.indexOf(a.scene) - MEDIA_SCENES.indexOf(b.scene));
}

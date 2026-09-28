import { describe, expect, it } from 'vitest';

import { MEDIA_SCENES, sceneLabelKey, sceneLabels } from './scenes';

/*
 * Every label the scene tables read, held against the words each engine really uses, so a table
 * can never wait for a label its engine does not have: `hotdog` where ML Kit says `Hot dog`, a
 * plural where Vision's identifier is singular. A misspelt label is not an error anywhere else -
 * it simply never matches, and the scene it was meant to find goes quiet on one phone.
 *
 * VISION: `VNClassifyImageRequest().supportedIdentifiers()`, the same 1303 identifiers for
 * revision 1 (iOS 16) and revision 2 (iOS 17 on), dumped on macOS with Xcode 26.
 *
 * ML KIT: `0-labels-en.txt` inside `mobile_ica_8bit_with_metadata_tflite`, the model the
 * `com.google.mlkit:image-labeling` 17.0.9 AAR bundles, in index order. ML Kit's `ImageLabel.text` is
 * this English name.
 */
const VISION = `
  abacus accordion acorn acrobat adult adult_cat agriculture aircraft airplane airport airshow
  alley alligator_crocodile almond ambulance amusement_park anchovy angelfish animal ant antipasti
  anvil apartment apple appliance apricot apron aquarium arachnid arch archery arena armchair art
  arthropods artichoke arugula asparagus athletics atm atv auditorium aurora australian_shepherd
  automobile avocado axe baby backgammon backhoe backpack bacon badminton bag bagel baked_goods
  baklava balcony ball ballet ballet_dancer ballgames balloon balloon_hotair banana banner bar
  barbell barge barn barnacle barracuda barrel baseball baseball_bat baseball_hat basenji
  basket_container basketball basset bath bathrobe bathroom bathroom_faucet bathroom_room beach
  beagle bean beanie bear bed bedding bedroom bee beef beehive beekeeping beer beet begonia bell
  bell_pepper belltower bellydance bench bernese_mountain berry bib bichon bicycle billboards
  billiards binoculars bird birdhouse birthday_cake biryani biscotti biscuit bison blackberry
  bleachers blender blizzard blocks blossom blue_sky blueberry boar board_game boat boathouse
  bobcat bodyboard bongo_drum bonsai book bookshelf boot bottle bouquet bowl bowling bowtie boxing
  branch brass_music bread breakdancing brick brick_oven bride bridesmaid bridge briefcase
  broccoli broom brownie bruschetta bubble_tea bucket building bulldog bulldozer bullfighting
  bungee burrito bus butter butterfly cabinet cableway cactus cage cake cake_regular cakestand
  calculator calendar caliper camel camera camping candle candlestick candy candy_cane candy_other
  canine canoe cantaloupe canyon caprese car car_seat caramel cardboard_box carnation carnival
  carousel carrot cart carton cashew casino casserole cassette castle cat caterpillar cauliflower
  cave cd celebration celery celestial_body celestial_body_other cellar cello centipede cephalopod
  cereal ceremony cetacean chainsaw chair chair_other chairlift chaise chalkboard chameleon
  chandelier chart checkbook cheerleading cheese cheesecake cheetah cherry chess chestnut
  chewing_gum chihuahua child chimney chinchilla chives chocolate chocolate_chip chopsticks
  christmas_decoration christmas_tree chrysanthemum cigar cigarette cilantro circuit_board circus
  citrus_fruit cityscape clam clarinet classroom cliff cloak clock clock_tower closet clothesline
  clothespin clothing cloudy clover clown clownfish cockatoo cocktail coconut coffee coffee_bean
  coin coleslaw collie compass computer computer_keyboard computer_monitor computer_mouse
  computer_tower concert conch condiment conference consumer_electronics container convertible
  conveyance cookie cookware coral_reef cord corgi corkscrew corn cornflower cosmetic_tool costume
  cougar coupon cow cowboy_hat coyote_wolf crab cranberry crane_construction crate credit_card
  creek crepe crib cricket_sport croissant crosswalk crowd cruise_ship crutch cubicle cucumber cup
  cupcake currency curry curtain cutting_board cycling dachshund daffodil dahlia daikon daisy
  dalmatian dam dancing dandelion dartboard dashboard daytime decanter deck decoration
  decorative_plant deejay deer desert desk dessert diagram dial diaper dice dill dining_room
  dinosaur diorama dirt_road disco_ball dishwasher diskette diving doberman dock document dog doll
  dolphin dome domicile domino donkey donut door dove dragon_parade dragonfly dressage drink
  drinking_glass driveway drone_machine drum dumbbell dumpling durian eagle earmuffs easel
  easter_egg edamame egg eggplant electric_fan elephant elevator elk embers engine_vehicle
  entertainer envelope equestrian escalator eucalyptus_tree evergreen extinguisher eyeglasses
  fairground falafel farm fedora feline fence fencing_sport ferns ferret ferris_wheel fig figurine
  fire firecracker fireplace firetruck fireworks fish fishbowl fishing fishtank flag flagpole
  flame flamingo flan flashlight flipchart flipper flower flower_arrangement flute folding_chair
  foliage fondue food foosball football footwear forest fork forklift formula_one_car fountain fox
  frame fried_chicken fried_egg fries frisbee frog frozen frozen_dessert fruit fruitcake furniture
  gamepad games garage garden gargoyle garlic gas_mask gastropod gazebo gears gecko gerbil
  german_shepherd geyser gift gift_card gingerbread giraffe glacier glove glove_other go_kart goat
  goggles goldfish golf golf_ball golf_club golf_course gown graduation graffiti grain grand_prix
  grape grapefruit grass grater grave green_beans greenhouse greyhound grill grilled_chicken groom
  guacamole guava guitar gull guppy gymnastics gyoza habanero ham hamburger hammer hammock hamster
  handwriting hangar hangglider harbour hardhat harp hat haze headgear headphones health_club
  hedgehog helicopter helmet henna herb heron high_chair high_heel hiking hill hippopotamus hockey
  holly honey honeydew hoodie hookah horse horseshoe hospital hotdog hound hourglass house_single
  houseboat housewares hula hummingbird hummus hunting hurdle husky hydrant hyena ice ice_cream
  ice_skates ice_skating iceberg igloo iguana illustrations insect interior_room interior_shop
  irish_wolfhound iron_clothing island ivy jack_o_lantern jack_russell_terrier jacket jacuzzi
  jalapeno jar jeans jeep jello jelly jellyfish jetski jewelry jigsaw jockey_horse joystick jug
  juggling juice juicer jungle kangaroo karaoke kayak kebab keg kettle keypad kickboxing kilt
  kimono kitchen kitchen_countertop kitchen_faucet kitchen_oven kitchen_room kitchen_sink kite
  kiteboarding kitten kiwi knife koala kohlrabi koi lab_coat ladle ladybug lake lamp lamppost land
  lantern laptop laundry_machine lava leash leek lemon lemongrass lemur leopard leotard lettuce
  library license_plate lifejacket lifesaver light light_bulb lighter lighthouse lightning lily
  lime limousine lion lionfish liquid liquor living_room lizard llama loafer lobster lollipop
  luggage lychee lynx macadamia machine mackerel magazine mailbox malamute malinois mallet mammal
  mandarine mango mangosteen mangrove manhole map maple_tree margarita marigold marshmallow
  marsupial martial_arts martini mask mast mastiff matches material matzo measuring_tape meat
  meatball medal media medicine megalith megaphone melon microphone microscope microwave
  military_uniform milkshake millipede mistletoe mitten moccasin mojito mollusk money
  monitor_lizard monorail monument moon moose mop moss moth motocross motorcycle motorhome
  motorsport mountain mousetrap mower muffin mug museum mushroom music musical_instrument mussel
  mustard naan nachos nascar necktie nectarine nest newfoundland newspaper night_sky nightclub nut
  oak_tree oar oatmeal obelisk ocean office_supplies omelet onion optical_equipment oranges
  orchard orchestra orchid organ_instrument origami ostrich otter outdoor oven owl oyster pacifier
  paella paintball paintbrush painting palm_tree pan pancake panda papaya paper_bag parachute
  parade parakeet parasailing park parking_lot parrot passionfruit passport pasta pastry path
  patio payphone pea peach peacock peanut pear pecan pelican pen penguin people pepper_veggie
  pepperoni peregrine performance pergola persimmon petunia phone piano pickle pie pier pierogi
  pig pigeon piggybank pillow pineapple ping_pong pipe pistachio pita pitbull pizza plant plate
  play_card playground pliers plum podium poinsettia poker pole police_car polka_dots polo
  pomegranate pomeranian poncho poodle pool popcorn popsicle porch porcupine portal porthole
  pot_cooking potato poultry power_saw prairie_dog pretzel printed_page printer propeller puck
  pudding puffer_fish puffin pug pulley pumpkin puppet purse putt puzzles pylon pyramid
  pyrotechnics python quesadilla quinoa rabbit raccoon racquet radish rafting railroad rainbow
  rake rambutan ramen rangoli raptor raspberry rat ratchet rattlesnake raven raw_glass receipt
  record recreation red_envelope red_wine refrigerator reptile restaurant retriever rhinoceros
  rhubarb rice rice_field rickshaw ridgeback rim rink risotto river road road_other
  road_safety_equipment rock_climbing rocket rocks rodent rodeo roe rollercoaster rollerskates
  rollerskating rolling_pin roof rope rose rosemary rotisserie rottweiler roulette rowboat rugby
  ruins sack saddle safety_vest sailboat saint_bernard salad salami salmon samba samosa sand
  sand_dune sandal sandcastle sandpiper sandwich sangria santa_claus sardine sari satay sauerkraut
  sausage saxophone scallop scarab scarecrow scarf schnauzer scissors scone scooter scoreboard
  scorpion scrambled_eggs screenshot screwdriver scuba seabass seafood seahorse seal sealion
  seashell seasonings seat seaweed seed seesaw semi_truck sequoia sesame setter sewing shark
  shawarma shed sheep sheepdog shellfish shellfish_prepared shipyard shoes shopping_cart shore
  shower shrub sidewalk sign silo singer skateboard skateboarding skatepark skating skeleton
  ski_boot ski_equipment skiing skull skunk sky skydiving skyscraper sled sledding slide_toy
  smokestack smoking_item smoothie snail snake snake_other snapdragon snapper sneaker snorkeling
  snow snowball snowboard snowboarding snowman snowmobile snowshoe soccer sock soda sofa softball
  solar_panel sombrero souffle soup souvlaki spaghetti spaniel spareribs sparkler sparkling_wine
  sparrow spatula speakers_music speedboat spice spider spiderweb spinach spoon sport
  sports_equipment sportscar spotlight springroll sprinkler squash_sport squirrel stadium
  stained_glass stairs starfish starfruit statue steak steamer_cookware stereo stethoscope
  sticky_note stingray stir_fry stool stopwatch storefront stork storm stove straw_drinking
  straw_hay strawberry street street_sign streetcar stretcher string_instrument stroller structure
  strudel stuffed_animals submarine_water sugar_cube suit suitcase sumo sun sunbathing sundial
  sunfish sunflower sunflower_seeds sunglasses sunhat sunset_sunrise surfboard surfing sushi suv
  swan swimming swimsuit swing_playground swivel_chair sword swordfish syringe tabbouleh table
  tableware tachometer taco taffy tambourine tapas tapioca_pearls taro tattoo tea_drink teapot
  teen telescope television tempura tennis tent tequila teriyaki terrarium terrier textile theater
  thermometer thermos thermostat thunderstorm tiara ticket tiger timepiece tiramisu tire toad
  toaster toaster_oven toilet_seat tomato tool toolbox tornado tortilla tortoise toucan tower toy
  track_rail tractor traffic_light trail train train_real train_station train_toy trampoline
  tramway trash_can treadmill tree tricycle tripod trombone trophy trout truck trumpet tuba tulip
  tuna tunnel turmeric turntable turtle tuxedo typewriter ukulele umbrella underwater ungulates
  urchin utensil vacuum van vase vegetable vegetation vehicle vehicle_toy videogame vineyard
  violin vizsla volcano volleyball vulture waffle wagon wakeboarding wallet walrus warship wasabi
  washbasin watch water water_body watercraft waterfall watering_can watermelon watermill
  waterpolo watersport waterways wedding wedding_cake wedding_dress weight_scale weimaraner
  wetland wetsuit whale wheat wheel wheelbarrow wheelchair whisk white_bread white_wine whiteboard
  willow winch wind_turbine windmill window windsurfing wine wine_bottle winter_sport wonton
  wood_natural wood_processed woodpecker woodwind workout worm wreath wrench wrestling xylophone
  yacht yarn yoga yogurt yolk zebra zoo zucchini
`.trim().split(/\s+/);

/* ML Kit's names can hold a space, so this list is one per line. */
const MLKIT = `
Team
Bonfire
Comics
Himalayan
Iceberg
Bento
Laundry
Sink
Toy
Statue
Cheeseburger
Tractor
Sled
Aquarium
Circus
Mascot
Sitting
Beard
Bridge
Tights
Bird
Rafting
Park
Doll
Factory
Graduation
Porcelain
Twig
Petal
Cushion
Sunglasses
Infrastructure
Ferris wheel
Pomacentridae
Wetsuit
Shetland sheepdog
Brig
Watercolor paint
Competition
Cliff
Badminton
Safari
Bicycle
Stadium
Diwali
Boat
Smile
Surfboard
Fast food
Sunset
Hot dog
Shorts
Bus
Bullfighting
Sky
Gerbil
Rock
Interaction
Dress
Toe
Pest
Bear
Eating
Tower
Brick
Junk
Person
Windsurfing
Swimwear
Roller
Camping
Playground
Bathroom
Laugh
Balloon
Concert
Prom
Construction
Product
Reef
Picnic
Wreath
Wheelbarrow
Boxer
Necklace
Bracelet
Casino
Windshield
Stairs
Computer
Cookware and bakeware
Monochrome
Chair
Poster
Bar
Shipwreck
Pier
Community
Caving
Cave
Tie
Cabinetry
Underwater
Clown
Nightclub
Cycling
Comet
Mortarboard
Track
Christmas
Church
Clock
Dude
Cattle
Jungle
Desk
Curling
Cuisine
Cat
Juice
Couscous
Screenshot
Crew
Skyline
Youth
Stuffed toy
Cookie
Tile
Hanukkah
Crochet
Skateboarder
Clipper
Nail
Cola
Cutlery
Menu
Costume
Sari
Plush
Pocket
Neon
Icicle
Pasteles
Chain
Dance
Dune
Santa claus
Thanksgiving
Tuxedo
Mouth
Desert
Dinosaur
Mufti
Fire
Bedroom
Goggles
Dragon
Couch
Sledding
Cap
Whiteboard
Hat
Gelato
Cavalier
Beanie
Jersey
Scarf
Vacation
Pitch
Blackboard
Deejay
Monument
Bumper
Longboard
Waterfowl
Flesh
Net
Icing
Dalmatian
Speedboat
Trunk
Coffee
Soccer
Ragdoll
Food
Standing
Fiction
Fruit
Pho
Sparkler
Presentation
Swing
Cairn terrier
Forest
Flag
Frigate
Foot
Jacket
Gun
Pillow
Firearm
Bathing
Glacier
Gymnastics
Ear
Flora
Shell
Grandparent
Ruins
Eyelash
Bunk bed
Balance
Backpacking
Horse
Glitter
Saucer
Hair
Miniature
Crowd
Curtain
Icon
Pixie-bob
Herd
Insect
Ice
Bangle
Flap
Jewellery
Knitting
Centrepiece
Outerwear
Love
Muscle
Motorcycle
Money
Mosque
Tableware
Ballroom
Kayak
Leisure
Receipt
Lake
Lighthouse
Bridle
Leather
Horn
Strap
Lego
Scuba diving
Leggings
Pool
Musical instrument
Musical
Metal
Moon
Blazer
Marriage
Mobile phone
Militia
Tablecloth
Party
Nebula
News
Newspaper
Primate
Piano
Plant
Passport
Penguin
Shikoku
Palace
Doily
Polo
Paper
Pop music
Skiff
Pizza
Pet
Quilting
Cage
Skateboard
Surfing
Rugby
Lipstick
River
Race
Rowing
Road
Running
Room
Roof
Star
Sports
Shoe
Tubing
Space
Sleep
Skin
Swimming
School
Sushi
Loveseat
Superman
Cool
Skiing
Submarine
Song
Class
Skyscraper
Volcano
Television
Rein
Tattoo
Train
Handrail
Cup
Vehicle
Handbag
Lampshade
Event
Wine
Wing
Wheel
Wakeboarding
Web page
Zoo
Monkey
Ranch
Fishing
Heart
Cotton
Cappuccino
Bread
Sand
Soldier
Museum
Helicopter
Mountain
Duck
Soil
Turtle
Crocodile
Musician
Sneakers
Wool
Ring
Singer
Carnival
Snowboarding
Waterskiing
Wall
Rocket
Countertop
Beach
Rainbow
Branch
Moustache
Garden
Gown
Field
Dog
Superhero
Flower
Placemat
Subwoofer
Cathedral
Building
Airplane
Fur
Bull
Bench
Temple
Butterfly
Model
Marathon
Needlework
Kitchen
Castle
Aurora
Larva
Racing
Human
Airliner
Dam
Textile
Groom
Fun
Steaming
Vegetable
Unicycle
Jeans
Flowerpot
Drawer
Cake
Armrest
Aviation
Aggression
Fog
Fireworks
Farm
Seal
Shelf
Bangs
Lightning
Van
Sphynx
Tire
Denim
Prairie
Snorkeling
Umbrella
Asphalt
Sailboat
Basset hound
Pattern
Supper
Veil
Waterfall
Animal
Lunch
Odometer
Baby
Glasses
Car
Aircraft
Hand
Rodeo
Canyon
Meal
Softball
Alcohol
Bride
Swamp
Pie
Bag
Joker
Supervillain
Army
Canoe
Selfie
Rickshaw
Barn
Archery
Aerospace engineering
Child
Storm
Helmet
`.trim().split('\n');

/*
 * MEDIAPIPE: the 1000 ImageNet class names EfficientNet-Lite0 carries in its metadata
 * (`labels_without_background.txt` inside `web-assets/labeling/efficientnet_lite0.tflite`), which the
 * browser's classifier hands back as its `categoryName`s. Two of them appear twice (`crane` the bird
 * and the machine, `maillot` twice), and `Cardigan` the corgi keys as `cardigan` the sweater.
 */
const IMAGENET = `
tench
goldfish
great white shark
tiger shark
hammerhead
electric ray
stingray
cock
hen
ostrich
brambling
goldfinch
house finch
junco
indigo bunting
robin
bulbul
jay
magpie
chickadee
water ouzel
kite
bald eagle
vulture
great grey owl
European fire salamander
common newt
eft
spotted salamander
axolotl
bullfrog
tree frog
tailed frog
loggerhead
leatherback turtle
mud turtle
terrapin
box turtle
banded gecko
common iguana
American chameleon
whiptail
agama
frilled lizard
alligator lizard
Gila monster
green lizard
African chameleon
Komodo dragon
African crocodile
American alligator
triceratops
thunder snake
ringneck snake
hognose snake
green snake
king snake
garter snake
water snake
vine snake
night snake
boa constrictor
rock python
Indian cobra
green mamba
sea snake
horned viper
diamondback
sidewinder
trilobite
harvestman
scorpion
black and gold garden spider
barn spider
garden spider
black widow
tarantula
wolf spider
tick
centipede
black grouse
ptarmigan
ruffed grouse
prairie chicken
peacock
quail
partridge
African grey
macaw
sulphur-crested cockatoo
lorikeet
coucal
bee eater
hornbill
hummingbird
jacamar
toucan
drake
red-breasted merganser
goose
black swan
tusker
echidna
platypus
wallaby
koala
wombat
jellyfish
sea anemone
brain coral
flatworm
nematode
conch
snail
slug
sea slug
chiton
chambered nautilus
Dungeness crab
rock crab
fiddler crab
king crab
American lobster
spiny lobster
crayfish
hermit crab
isopod
white stork
black stork
spoonbill
flamingo
little blue heron
American egret
bittern
crane
limpkin
European gallinule
American coot
bustard
ruddy turnstone
red-backed sandpiper
redshank
dowitcher
oystercatcher
pelican
king penguin
albatross
grey whale
killer whale
dugong
sea lion
Chihuahua
Japanese spaniel
Maltese dog
Pekinese
Shih-Tzu
Blenheim spaniel
papillon
toy terrier
Rhodesian ridgeback
Afghan hound
basset
beagle
bloodhound
bluetick
black-and-tan coonhound
Walker hound
English foxhound
redbone
borzoi
Irish wolfhound
Italian greyhound
whippet
Ibizan hound
Norwegian elkhound
otterhound
Saluki
Scottish deerhound
Weimaraner
Staffordshire bullterrier
American Staffordshire terrier
Bedlington terrier
Border terrier
Kerry blue terrier
Irish terrier
Norfolk terrier
Norwich terrier
Yorkshire terrier
wire-haired fox terrier
Lakeland terrier
Sealyham terrier
Airedale
cairn
Australian terrier
Dandie Dinmont
Boston bull
miniature schnauzer
giant schnauzer
standard schnauzer
Scotch terrier
Tibetan terrier
silky terrier
soft-coated wheaten terrier
West Highland white terrier
Lhasa
flat-coated retriever
curly-coated retriever
golden retriever
Labrador retriever
Chesapeake Bay retriever
German short-haired pointer
vizsla
English setter
Irish setter
Gordon setter
Brittany spaniel
clumber
English springer
Welsh springer spaniel
cocker spaniel
Sussex spaniel
Irish water spaniel
kuvasz
schipperke
groenendael
malinois
briard
kelpie
komondor
Old English sheepdog
Shetland sheepdog
collie
Border collie
Bouvier des Flandres
Rottweiler
German shepherd
Doberman
miniature pinscher
Greater Swiss Mountain dog
Bernese mountain dog
Appenzeller
EntleBucher
boxer
bull mastiff
Tibetan mastiff
French bulldog
Great Dane
Saint Bernard
Eskimo dog
malamute
Siberian husky
dalmatian
affenpinscher
basenji
pug
Leonberg
Newfoundland
Great Pyrenees
Samoyed
Pomeranian
chow
keeshond
Brabancon griffon
Pembroke
Cardigan
toy poodle
miniature poodle
standard poodle
Mexican hairless
timber wolf
white wolf
red wolf
coyote
dingo
dhole
African hunting dog
hyena
red fox
kit fox
Arctic fox
grey fox
tabby
tiger cat
Persian cat
Siamese cat
Egyptian cat
cougar
lynx
leopard
snow leopard
jaguar
lion
tiger
cheetah
brown bear
American black bear
ice bear
sloth bear
mongoose
meerkat
tiger beetle
ladybug
ground beetle
long-horned beetle
leaf beetle
dung beetle
rhinoceros beetle
weevil
fly
bee
ant
grasshopper
cricket
walking stick
cockroach
mantis
cicada
leafhopper
lacewing
dragonfly
damselfly
admiral
ringlet
monarch
cabbage butterfly
sulphur butterfly
lycaenid
starfish
sea urchin
sea cucumber
wood rabbit
hare
Angora
hamster
porcupine
fox squirrel
marmot
beaver
guinea pig
sorrel
zebra
hog
wild boar
warthog
hippopotamus
ox
water buffalo
bison
ram
bighorn
ibex
hartebeest
impala
gazelle
Arabian camel
llama
weasel
mink
polecat
black-footed ferret
otter
skunk
badger
armadillo
three-toed sloth
orangutan
gorilla
chimpanzee
gibbon
siamang
guenon
patas
baboon
macaque
langur
colobus
proboscis monkey
marmoset
capuchin
howler monkey
titi
spider monkey
squirrel monkey
Madagascar cat
indri
Indian elephant
African elephant
lesser panda
giant panda
barracouta
eel
coho
rock beauty
anemone fish
sturgeon
gar
lionfish
puffer
abacus
abaya
academic gown
accordion
acoustic guitar
aircraft carrier
airliner
airship
altar
ambulance
amphibian
analog clock
apiary
apron
ashcan
assault rifle
backpack
bakery
balance beam
balloon
ballpoint
Band Aid
banjo
bannister
barbell
barber chair
barbershop
barn
barometer
barrel
barrow
baseball
basketball
bassinet
bassoon
bathing cap
bath towel
bathtub
beach wagon
beacon
beaker
bearskin
beer bottle
beer glass
bell cote
bib
bicycle-built-for-two
bikini
binder
binoculars
birdhouse
boathouse
bobsled
bolo tie
bonnet
bookcase
bookshop
bottlecap
bow
bow tie
brass
brassiere
breakwater
breastplate
broom
bucket
buckle
bulletproof vest
bullet train
butcher shop
cab
caldron
candle
cannon
canoe
can opener
cardigan
car mirror
carousel
carpenter's kit
carton
car wheel
cash machine
cassette
cassette player
castle
catamaran
CD player
cello
cellular telephone
chain
chainlink fence
chain mail
chain saw
chest
chiffonier
chime
china cabinet
Christmas stocking
church
cinema
cleaver
cliff dwelling
cloak
clog
cocktail shaker
coffee mug
coffeepot
coil
combination lock
computer keyboard
confectionery
container ship
convertible
corkscrew
cornet
cowboy boot
cowboy hat
cradle
crane
crash helmet
crate
crib
Crock Pot
croquet ball
crutch
cuirass
dam
desk
desktop computer
dial telephone
diaper
digital clock
digital watch
dining table
dishrag
dishwasher
disk brake
dock
dogsled
dome
doormat
drilling platform
drum
drumstick
dumbbell
Dutch oven
electric fan
electric guitar
electric locomotive
entertainment center
envelope
espresso maker
face powder
feather boa
file
fireboat
fire engine
fire screen
flagpole
flute
folding chair
football helmet
forklift
fountain
fountain pen
four-poster
freight car
French horn
frying pan
fur coat
garbage truck
gasmask
gas pump
goblet
go-kart
golf ball
golfcart
gondola
gong
gown
grand piano
greenhouse
grille
grocery store
guillotine
hair slide
hair spray
half track
hammer
hamper
hand blower
hand-held computer
handkerchief
hard disc
harmonica
harp
harvester
hatchet
holster
home theater
honeycomb
hook
hoopskirt
horizontal bar
horse cart
hourglass
iPod
iron
jack-o'-lantern
jean
jeep
jersey
jigsaw puzzle
jinrikisha
joystick
kimono
knee pad
knot
lab coat
ladle
lampshade
laptop
lawn mower
lens cap
letter opener
library
lifeboat
lighter
limousine
liner
lipstick
Loafer
lotion
loudspeaker
loupe
lumbermill
magnetic compass
mailbag
mailbox
maillot
maillot
manhole cover
maraca
marimba
mask
matchstick
maypole
maze
measuring cup
medicine chest
megalith
microphone
microwave
military uniform
milk can
minibus
miniskirt
minivan
missile
mitten
mixing bowl
mobile home
Model T
modem
monastery
monitor
moped
mortar
mortarboard
mosque
mosquito net
motor scooter
mountain bike
mountain tent
mouse
mousetrap
moving van
muzzle
nail
neck brace
necklace
nipple
notebook
obelisk
oboe
ocarina
odometer
oil filter
organ
oscilloscope
overskirt
oxcart
oxygen mask
packet
paddle
paddlewheel
padlock
paintbrush
pajama
palace
panpipe
paper towel
parachute
parallel bars
park bench
parking meter
passenger car
patio
pay-phone
pedestal
pencil box
pencil sharpener
perfume
Petri dish
photocopier
pick
pickelhaube
picket fence
pickup
pier
piggy bank
pill bottle
pillow
ping-pong ball
pinwheel
pirate
pitcher
plane
planetarium
plastic bag
plate rack
plow
plunger
Polaroid camera
pole
police van
poncho
pool table
pop bottle
pot
potter's wheel
power drill
prayer rug
printer
prison
projectile
projector
puck
punching bag
purse
quill
quilt
racer
racket
radiator
radio
radio telescope
rain barrel
recreational vehicle
reel
reflex camera
refrigerator
remote control
restaurant
revolver
rifle
rocking chair
rotisserie
rubber eraser
rugby ball
rule
running shoe
safe
safety pin
saltshaker
sandal
sarong
sax
scabbard
scale
school bus
schooner
scoreboard
screen
screw
screwdriver
seat belt
sewing machine
shield
shoe shop
shoji
shopping basket
shopping cart
shovel
shower cap
shower curtain
ski
ski mask
sleeping bag
slide rule
sliding door
slot
snorkel
snowmobile
snowplow
soap dispenser
soccer ball
sock
solar dish
sombrero
soup bowl
space bar
space heater
space shuttle
spatula
speedboat
spider web
spindle
sports car
spotlight
stage
steam locomotive
steel arch bridge
steel drum
stethoscope
stole
stone wall
stopwatch
stove
strainer
streetcar
stretcher
studio couch
stupa
submarine
suit
sundial
sunglass
sunglasses
sunscreen
suspension bridge
swab
sweatshirt
swimming trunks
swing
switch
syringe
table lamp
tank
tape player
teapot
teddy
television
tennis ball
thatch
theater curtain
thimble
thresher
throne
tile roof
toaster
tobacco shop
toilet seat
torch
totem pole
tow truck
toyshop
tractor
trailer truck
tray
trench coat
tricycle
trimaran
tripod
triumphal arch
trolleybus
trombone
tub
turnstile
typewriter keyboard
umbrella
unicycle
upright
vacuum
vase
vault
velvet
vending machine
vestment
viaduct
violin
volleyball
waffle iron
wall clock
wallet
wardrobe
warplane
washbasin
washer
water bottle
water jug
water tower
whiskey jug
whistle
wig
window screen
window shade
Windsor tie
wine bottle
wing
wok
wooden spoon
wool
worm fence
wreck
yawl
yurt
web site
comic book
crossword puzzle
street sign
traffic light
book jacket
menu
plate
guacamole
consomme
hot pot
trifle
ice cream
ice lolly
French loaf
bagel
pretzel
cheeseburger
hotdog
mashed potato
head cabbage
broccoli
cauliflower
zucchini
spaghetti squash
acorn squash
butternut squash
cucumber
artichoke
bell pepper
cardoon
mushroom
Granny Smith
strawberry
orange
lemon
fig
pineapple
banana
jackfruit
custard apple
pomegranate
hay
carbonara
chocolate sauce
dough
meat loaf
pizza
potpie
burrito
red wine
espresso
cup
eggnog
alp
bubble
cliff
coral reef
geyser
lakeside
promontory
sandbar
seashore
valley
volcano
ballplayer
groom
scuba diver
rapeseed
daisy
yellow lady's slipper
corn
acorn
hip
buckeye
coral fungus
agaric
gyromitra
stinkhorn
earthstar
hen-of-the-woods
bolete
ear
toilet tissue
`.trim().split('\n');

/*
 * The labels the bundled model can never hand over: the score calibration file beside the labels
 * has no curve for them, so their calibrated score is the default of 0 and the default threshold
 * drops them. A rule on one of these would be a rule that never fires.
 */
const MLKIT_SILENT = ["Laundry", "Mascot", "Doll", "Diwali", "Pest", "Youth", "Costume", "Gun", "Firearm", "Primate", "Zoo", "Monkey", "Soldier", "Human", "Aggression", "Animal", "Child"];

describe('the scene tables and the engines they read', () => {
  it('reads only labels Vision knows', () => {
    const known = new Set(VISION);
    expect(VISION.length).toBe(1303);
    const unknown = [...sceneLabels('vision').keys()].filter((label) => !known.has(label));
    expect(unknown).toEqual([]);
  });

  it('reads only labels ML Kit knows and can actually give', () => {
    const known = new Set(MLKIT.map(sceneLabelKey));
    const silent = new Set(MLKIT_SILENT.map(sceneLabelKey));
    expect(MLKIT.length).toBe(447);
    const labels = [...sceneLabels('mlkit').keys()];
    expect(labels.filter((label) => !known.has(label))).toEqual([]);
    expect(labels.filter((label) => silent.has(label))).toEqual([]);
  });

  it('reads only labels the classifier in a browser knows', () => {
    const known = new Set(IMAGENET.map(sceneLabelKey));
    expect(IMAGENET.length).toBe(1000);
    expect([...sceneLabels('mediapipe').keys()].filter((label) => !known.has(label))).toEqual([]);
  });

  it('gives every scene at least one label on each phone, so no scene is one phone only', () => {
    for (const engine of ['vision', 'mlkit'] as const) {
      const said = new Set([...sceneLabels(engine).values()].flat());
      expect(MEDIA_SCENES.filter((scene) => !said.has(scene)), engine).toEqual([]);
    }
  });

  /*
   * ImageNet has no class for a person, a sunset or the sky, so a browser cannot say those two: a
   * sunset over the sea reads as a beach there. Named here so the gap is a decision, not an accident.
   */
  it('gives every scene a label in a browser but the two ImageNet has nothing for', () => {
    const said = new Set([...sceneLabels('mediapipe').values()].flat());
    expect(MEDIA_SCENES.filter((scene) => !said.has(scene))).toEqual(['people', 'sunset']);
  });

  it('keys a label as ML Kit writes it and as Vision writes it the same way', () => {
    expect(sceneLabelKey('Fast food')).toBe('fast_food');
    expect(sceneLabelKey('Pixie-bob')).toBe('pixie_bob');
    expect(sceneLabelKey(' Scuba  diving ')).toBe('scuba_diving');
    expect(sceneLabelKey('sunset_sunrise')).toBe('sunset_sunrise');
  });
});

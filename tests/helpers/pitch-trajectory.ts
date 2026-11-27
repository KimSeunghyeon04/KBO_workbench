// One constant-acceleration flight, represented 0.04 s apart. It crosses y=1.76 at
// t=0.44 s from 55 ft and at (x, z) = (2.6544, 2.216) ft.
export const pitchFrom55Feet = {
  x0: 1,
  y0: 55,
  z0: 6,
  vx0: 2,
  vy0: -125.4,
  vz0: -2,
  ax: 8,
  ay: 20,
  az: -30,
  crossPlateX: 2.6544,
  crossPlateY: 1.76,
};

export const pitchFrom50Feet = {
  ...pitchFrom55Feet,
  x0: 1.0864,
  y0: 50,
  z0: 5.896,
  vx0: 2.32,
  vy0: -124.6,
  vz0: -3.2,
};

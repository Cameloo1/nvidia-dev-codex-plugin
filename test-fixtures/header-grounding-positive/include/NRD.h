#pragma once

#define NRD_VERSION_MAJOR 4
namespace nrd {
struct Denoiser {};
}
enum class NrdMethods {
  ReBLUR,
  ReLAX,
  SIGMA
};

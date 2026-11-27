#pragma once
#include <cstdint>
#include <string_view>

namespace noticoin::network {
inline constexpr unsigned decimals = 9;
inline constexpr uint64_t atomicUnits = 1000000000ULL;
inline constexpr uint64_t targetSeconds = 45;
inline constexpr unsigned spendableAgeBlocks = 6;
inline constexpr std::string_view mainnet = "2784467d7c909874668b9f0accf533c63f77aad79a3b72bfc5b23ca09e3cb614";
inline constexpr std::string_view testnet = "e2c8d4803df588a35e8289d2f939f3521ec92c43d4e8e453d05585917c205a90";
inline constexpr std::string_view stagenet = "090c1b22ef96a0d7e05d7ec6321ad3f61d4f36c90cce2ce573e3c4be19f8daef";

constexpr bool matches(std::string_view genesis)
{
    return genesis == mainnet || genesis == testnet || genesis == stagenet;
}
}

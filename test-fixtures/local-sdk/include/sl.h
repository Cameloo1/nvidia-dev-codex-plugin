namespace sl {
enum class Result { eOk, eError };
}

#define SL_FEATURE_DLSS 1
int slInit();
int slShutdown();

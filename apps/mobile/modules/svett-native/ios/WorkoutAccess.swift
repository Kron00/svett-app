import HealthKit

/// Asks to read workouts from Apple Health. Health never says whether a read was allowed, so the
/// answer also counts the workouts the app can read afterwards.
enum WorkoutAccess {
    private static let store = HKHealthStore()

    static func request() async -> [String: Any] {
        guard HKHealthStore.isHealthDataAvailable() else { return ["kind": "unavailable"] }
        do {
            try await store.requestAuthorization(toShare: [], read: [HKObjectType.workoutType()])
        } catch {
            return ["kind": "refused", "reason": error.localizedDescription]
        }
        switch await readableWorkouts() {
        case .success(let workouts):
            return ["kind": "read", "workouts": workouts]
        case .failure(let error):
            return ["kind": "query failed", "reason": error.localizedDescription]
        }
    }

    private static func readableWorkouts() async -> Result<Int, Error> {
        await withCheckedContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: HKObjectType.workoutType(), predicate: nil, limit: HKObjectQueryNoLimit,
                sortDescriptors: nil
            ) { _, samples, error in
                if let error {
                    continuation.resume(returning: .failure(error))
                } else {
                    continuation.resume(returning: .success(samples?.count ?? 0))
                }
            }
            store.execute(query)
        }
    }
}
